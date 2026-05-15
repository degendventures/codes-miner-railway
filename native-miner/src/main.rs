use primitive_types::U256;
use std::collections::HashMap;
use std::env;
use std::io::{self, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tiny_keccak::{Hasher, Keccak};

#[derive(Debug)]
enum Msg {
    Rate {
        worker_id: usize,
        rate: u64,
        nonce: u64,
        hash: String,
    },
    Found {
        worker_id: usize,
        nonce: u64,
        hash: String,
    },
}

fn clean_hex(s: &str) -> &str {
    s.strip_prefix("0x").unwrap_or(s)
}

fn decode_fixed_hex(s: &str, len: usize) -> Vec<u8> {
    let raw = hex::decode(clean_hex(s)).expect("invalid hex");
    assert_eq!(raw.len(), len, "invalid hex length");
    raw
}

fn u256_to_bytes(value: U256) -> [u8; 32] {
    let mut out = [0u8; 32];
    value.to_big_endian(&mut out);
    out
}

fn keccak256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    let mut out = [0u8; 32];
    hasher.update(input);
    hasher.finalize(&mut out);
    out
}

fn short_hash(hash: &str) -> String {
    if hash.len() <= 18 {
        return hash.to_string();
    }

    format!("{}...{}", &hash[..10], &hash[hash.len() - 4..])
}

fn format_hashrate(rate: u64) -> String {
    let r = rate as f64;

    if r >= 1_000_000_000.0 {
        format!("{:.2} GH/s", r / 1_000_000_000.0)
    } else if r >= 1_000_000.0 {
        format!("{:.2} MH/s", r / 1_000_000.0)
    } else if r >= 1_000.0 {
        format!("{:.2} KH/s", r / 1_000.0)
    } else {
        format!("{} H/s", rate)
    }
}

fn build_packed(
    miner: &[u8],
    batch: U256,
    challenge: &[u8],
    nonce: u64,
    chain_id: U256,
    contract: &[u8],
) -> Vec<u8> {
    let mut packed = Vec::with_capacity(168);

    packed.extend_from_slice(miner);
    packed.extend_from_slice(&u256_to_bytes(batch));
    packed.extend_from_slice(challenge);
    packed.extend_from_slice(&u256_to_bytes(U256::from(nonce)));
    packed.extend_from_slice(&u256_to_bytes(chain_id));
    packed.extend_from_slice(contract);

    packed
}

fn main() {
    let miner = env::var("MINER_ADDRESS").expect("missing MINER_ADDRESS");
    let batch = env::var("BATCH").expect("missing BATCH");
    let challenge = env::var("CHALLENGE").expect("missing CHALLENGE");
    let chain_id = env::var("CHAIN_ID").unwrap_or_else(|_| "1".to_string());
    let contract = env::var("CODES_ADDRESS").expect("missing CODES_ADDRESS");
    let target = env::var("TARGET").expect("missing TARGET");

    let workers: usize = env::var("WORKERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(num_cpus::get);

    let log_every_ms: u64 = env::var("LOG_EVERY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30000);

    let miner_bytes = decode_fixed_hex(&miner, 20);
    let challenge_bytes = decode_fixed_hex(&challenge, 32);
    let contract_bytes = decode_fixed_hex(&contract, 20);

    let batch_u256 = U256::from_dec_str(&batch).expect("invalid batch");
    let chain_u256 = U256::from_dec_str(&chain_id).expect("invalid chain id");
    let target_u256 = U256::from_dec_str(&target).expect("invalid target");

    let start_nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        * 1_000_000;

    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Msg>();

    println!("[native] version=total-rate-v2 mode=cpu workers={}", workers);
    println!("[native] start_nonce={}", start_nonce);
    io::stdout().flush().unwrap();

    for worker_id in 0..workers {
        let miner_bytes = miner_bytes.clone();
        let challenge_bytes = challenge_bytes.clone();
        let contract_bytes = contract_bytes.clone();
        let stop = stop.clone();
        let tx = tx.clone();

        thread::spawn(move || {
            let mut nonce = start_nonce + worker_id as u64;
            let step = workers as u64;
            let mut hashes: u64 = 0;
            let mut last_log = Instant::now();

            while !stop.load(Ordering::Relaxed) {
                let packed = build_packed(
                    &miner_bytes,
                    batch_u256,
                    &challenge_bytes,
                    nonce,
                    chain_u256,
                    &contract_bytes,
                );

                let hash = keccak256(&packed);
                let hash_u256 = U256::from_big_endian(&hash);

                hashes += 1;

                if hash_u256 <= target_u256 {
                    stop.store(true, Ordering::Relaxed);

                    let hash_hex = format!("0x{}", hex::encode(hash));

                    let _ = tx.send(Msg::Found {
                        worker_id,
                        nonce,
                        hash: hash_hex,
                    });

                    break;
                }

                if last_log.elapsed() >= Duration::from_millis(log_every_ms) {
                    let elapsed = last_log.elapsed().as_secs_f64();
                    let rate = (hashes as f64 / elapsed) as u64;
                    let hash_hex = format!("0x{}", hex::encode(hash));

                    let _ = tx.send(Msg::Rate {
                        worker_id,
                        rate,
                        nonce,
                        hash: short_hash(&hash_hex),
                    });

                    hashes = 0;
                    last_log = Instant::now();
                }

                nonce = nonce.wrapping_add(step);
            }
        });
    }

    drop(tx);

    let mut rates: HashMap<usize, u64> = HashMap::new();
    let mut last_nonce: u64 = start_nonce;
    let mut last_hash: String = "-".to_string();
    let mut last_print = Instant::now();

    for msg in rx {
        match msg {
            Msg::Rate {
                worker_id,
                rate,
                nonce,
                hash,
            } => {
                rates.insert(worker_id, rate);
                last_nonce = nonce;
                last_hash = hash;

                if rates.len() >= workers
                    && last_print.elapsed() >= Duration::from_millis(log_every_ms)
                {
                    let total_rate: u64 = rates.values().copied().sum();

                    println!(
                        "[scan] hashrate={} nonce={} hash={}",
                        format_hashrate(total_rate),
                        last_nonce,
                        last_hash
                    );
                    io::stdout().flush().unwrap();

                    rates.clear();
                    last_print = Instant::now();
                }
            }
            Msg::Found {
                worker_id,
                nonce,
                hash,
            } => {
                println!("[FOUND] worker={} nonce={} hash={}", worker_id, nonce, hash);
                io::stdout().flush().unwrap();
                break;
            }
        }
    }
}
