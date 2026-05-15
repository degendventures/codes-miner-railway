# $CODES Native CPU Miner

Native CPU miner for the $CODES mine-to-mint protocol on Ethereum Mainnet.

## Contract

```txt
Network: Ethereum Mainnet
CODES: 0xdAeEB910888e3613638C6a9b71691C72B2e7DD36
```

## How it works

The miner uses:

- Rust native CPU scanner to search valid nonces.
- Node.js submitter to submit `submitBlock(nonce)` when a valid proof is found.
- `.env` private key to auto-sign the submit transaction.

Browser mining uses wallet popups.

CLI mining uses `MINER_PRIVATE_KEY` and auto-submits when a valid block is found.

GPU miner is not included yet. Current tested mode is native CPU mining.

## 1. Install dependencies

Run as root:

```bash
apt update && apt upgrade -y
apt install -y curl git build-essential pkg-config screen tmux
```

## 2. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

node -v
npm -v
```

## 3. Install Rust

```bash
curl https://sh.rustup.rs -sSf | sh -s -- -y
source /root/.cargo/env

rustc --version
cargo --version
```

## 4. Clone miner

```bash
cd /root

git clone https://github.com/404-Agent/codes-miner.git
cd codes-miner
```

## 5. Install Node.js packages

```bash
npm install
```

## 6. Build native CPU miner

```bash
cd /root/codes-miner/native-miner

cargo build --release

ls -lah target/release/codes-native-miner
```

Expected binary:

```txt
/root/codes-miner/native-miner/target/release/codes-native-miner
```

## 7. Configure `.env`

```bash
cd /root/codes-miner

cp .env.example .env
nano .env
chmod 600 .env
```

Example:

```env
ETH_RPC=https://YOUR_ETH_MAINNET_RPC
MINER_PRIVATE_KEY=YOUR_MINER_PRIVATE_KEY
CODES_ADDRESS=0xdAeEB910888e3613638C6a9b71691C72B2e7DD36
CHAIN_ID=1
WORKERS=12
LOG_EVERY_MS=30000
NATIVE_REFRESH_MS=0
NATIVE_BIN=/root/codes-miner/native-miner/target/release/codes-native-miner
```

Important:

- Use a fresh miner wallet.
- Do not use your main wallet private key.
- The miner wallet needs ETH for gas.
- Never share your `.env` file.
- Never upload `.env` anywhere.

## 8. Set workers

Check CPU threads:

```bash
nproc
```

Edit `.env`:

```bash
nano .env
```

Example for 48 threads:

```env
WORKERS=48
LOG_EVERY_MS=30000
```

`LOG_EVERY_MS=30000` means scan logs appear every 30 seconds.

## 9. Run miner

```bash
cd /root/codes-miner

node mine-native.mjs
```

Expected output:

```txt
==================================================
 $CODES NATIVE MINER
==================================================
wallet   : 0x...
contract : 0xdAeEB910888e3613638C6a9b71691C72B2e7DD36
mode     : native-cpu
workers  : 48
native   : /root/codes-miner/native-miner/target/release/codes-native-miner
==================================================

[sync] block     : ...
[sync] batch     : ...
[sync] challenge : 0x...
[sync] target    : ...
[sync] supply    : ... / 10,000,000
[sync] balance   : ... $CODES
[mine] native CPU scan started

[native] version=total-rate-v2 mode=cpu workers=48
[native] start_nonce=...
[scan] hashrate=3.23 MH/s nonce=... hash=0x...
```

## 10. When a valid block is found

The miner auto-submits the transaction.

```txt
[FOUND] worker=... nonce=... hash=0x...

==================================================
[FOUND]
nonce : ...
hash  : 0x...
[tx] submitting block...
==================================================
[tx] hash: 0x...
[tx] waiting confirmation...
[tx] confirmed in block: ...
[reward] 1000 $CODES minted if tx succeeded
```

CLI mining does not show a wallet popup.

Browser mining:

- Wallet popup appears.
- User confirms `submitBlock` manually.

CLI mining:

- Uses `MINER_PRIVATE_KEY` from `.env`.
- Automatically signs and submits `submitBlock(nonce)`.

## 11. Run in background

```bash
cd /root/codes-miner

screen -S codes-native
node mine-native.mjs
```

Detach from screen:

```txt
CTRL + A, then D
```

Return to miner:

```bash
screen -r codes-native
```

## 12. Stop miner

```bash
pkill -f "mine-native.mjs" || true
pkill -f "codes-native-miner" || true
```

## Common messages

```txt
[wait] wallet already won batch 1
```

This means the wallet already won in the current batch. One wallet can only win once per batch. Wait for the next batch or use another miner wallet.

```txt
insufficient funds
```

The miner wallet needs more ETH for gas.

```txt
Wrong chain
```

The RPC is not Ethereum Mainnet.

```txt
RPC error / 503 / too many requests
```

Use a better Ethereum Mainnet RPC.

## Notes

- Current tested mode is native CPU mining.
- GPU miner is coming later.
- Do not upload `.env`.
- Do not expose private keys.
