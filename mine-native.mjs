import "dotenv/config";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { ethers } from "ethers";
import fetch from "node-fetch";

const RPC = process.env.ETH_RPC;
const PRIVATE_KEY = process.env.MINER_PRIVATE_KEY;
const CODES_ADDRESS =
  process.env.CODES_ADDRESS || "0xdAeEB910888e3613638C6a9b71691C72B2e7DD36";
const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const WORKERS = Number(process.env.WORKERS || Math.max(1, os.cpus().length - 1));
const LOG_EVERY_MS = Number(process.env.LOG_EVERY_MS || 30000);
const NATIVE_REFRESH_MS = Number(process.env.NATIVE_REFRESH_MS || 0);
const NATIVE_BIN =
  process.env.NATIVE_BIN ||
  "./native-miner/target/release/codes-native-miner";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PROTOCOL_FEE = ethers.parseEther("0.0005");

async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.log("[telegram error]", err.message);
  }
}

if (!RPC) throw new Error("Missing ETH_RPC in .env");
if (!PRIVATE_KEY) throw new Error("Missing MINER_PRIVATE_KEY in .env");

const ABI = [
  "function miningEnabled() view returns (bool)",
  "function currentBatch() view returns (uint256)",
  "function currentChallenge() view returns (bytes32)",
  "function difficultyTarget() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function wonInBatch(uint256,address) view returns (bool)",
  "function submitBlock(uint256 nonce) payable"
];

function shortHash(hash) {
  if (!hash) return "-";
  return `${hash.slice(0, 10)}...${hash.slice(-4)}`;
}

function fmtCodes(value) {
  return Number(ethers.formatUnits(value, 18)).toLocaleString("en-US", {
    maximumFractionDigits: 4
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFound(line) {
  const match =
    line.match(/^\[FOUND\] nonce=(\d+) hash=(0x[0-9a-fA-F]+)/) ||
    line.match(/^\[FOUND\] worker=\d+ nonce=(\d+) hash=(0x[0-9a-fA-F]+)/);

  if (!match) return null;

  return {
    nonce: match[1],
    hash: match[2]
  };
}

async function runNativeRound({ wallet, codes, provider }) {
  const [enabled, batch, challenge, target, supply, balance, blockNumber] =
    await Promise.all([
      codes.miningEnabled(),
      codes.currentBatch(),
      codes.currentChallenge(),
      codes.difficultyTarget(),
      codes.totalSupply(),
      codes.balanceOf(wallet.address),
      provider.getBlockNumber()
    ]);

  if (!enabled) {
    console.log("[wait] mining disabled");
    await sleep(10000);
    return;
  }

  const alreadyWon = await codes.wonInBatch(batch, wallet.address);

  if (alreadyWon) {
    console.log(`[wait] wallet already won batch ${batch.toString()}`);
    await sleep(15000);
    return;
  }

  console.log("");
  console.log("--------------------------------------------------");
  console.log("[sync] block     :", blockNumber);
  console.log("[sync] batch     :", batch.toString());
  console.log("[sync] challenge :", shortHash(challenge));
  console.log("[sync] target    :", target.toString());
  console.log("[sync] supply    :", `${fmtCodes(supply)} / 10,000,000`);
  console.log("[sync] balance   :", `${fmtCodes(balance)} $CODES`);
  console.log("[mine] native CPU scan started");
  console.log("--------------------------------------------------");

  const child = spawn(NATIVE_BIN, [], {
    env: {
      ...process.env,
      MINER_ADDRESS: wallet.address,
      BATCH: batch.toString(),
      CHALLENGE: challenge,
      CHAIN_ID: String(CHAIN_ID),
      CODES_ADDRESS,
      TARGET: target.toString(),
      WORKERS: String(WORKERS),
      LOG_EVERY_MS: String(LOG_EVERY_MS)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let found = null;
  let finished = false;

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  const timeout =
    NATIVE_REFRESH_MS > 0
      ? setTimeout(() => {
          if (!finished) {
            child.kill("SIGTERM");
          }
        }, NATIVE_REFRESH_MS)
      : null;

  child.stderr.on("data", (data) => {
    const text = String(data).trim();
    if (text) console.log("[native error]", text);
  });

  rl.on("line", (line) => {
    console.log(line);

    const parsed = parseFound(line);

    if (parsed && !found) {
      found = parsed;
      finished = true;
      if (timeout) clearTimeout(timeout);
      child.kill("SIGTERM");
    }
  });

  await new Promise((resolve) => {
    child.on("close", resolve);
  });

  if (timeout) clearTimeout(timeout);
  finished = true;

  if (!found) return;

  console.log("");
  console.log("==================================================");
  console.log("[FOUND]");
  console.log("nonce :", found.nonce);
  console.log("hash  :", found.hash);
  console.log("[tx] submitting block...");
  console.log("==================================================");

  try {
    const tx = await codes.submitBlock(found.nonce, {
      value: PROTOCOL_FEE
    });

    console.log("[tx] hash:", tx.hash);
    console.log("[tx] waiting confirmation...");

    const receipt = await tx.wait();

    console.log("[tx] confirmed in block:", receipt.blockNumber);
    console.log("[reward] 1000 $CODES minted if tx succeeded");
    
    await sendTelegramNotification(
      `🚀 *Mining Success!*\n\n` +
      `📦 *Batch:* ${batch.toString()}\n` +
      `🔗 *TX:* [View on Etherscan](https://etherscan.io/tx/${tx.hash})\n` +
      `💰 *Reward:* 1,000 $CODES`
    );
  } catch (err) {
    console.log("[submit error]", err?.reason || err?.shortMessage || err?.message || err);
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(
    RPC,
    { chainId: CHAIN_ID, name: "mainnet" },
    { batchMaxCount: 1 }
  );

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const codes = new ethers.Contract(CODES_ADDRESS, ABI, wallet);

  console.log("==================================================");
  console.log(" $CODES NATIVE MINER");
  console.log("==================================================");
  console.log("wallet   :", wallet.address);
  console.log("contract :", CODES_ADDRESS);
  console.log("mode     :", "native-cpu");
  console.log("workers  :", WORKERS);
  console.log("native   :", NATIVE_BIN);
  console.log("==================================================");

  const network = await provider.getNetwork();

  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong chain. Expected ${CHAIN_ID}, got ${network.chainId}`);
  }

  while (true) {
    await runNativeRound({ wallet, codes, provider });
    await sleep(1500);
  }
}

main().catch((err) => {
  console.error("[fatal]", err?.message || err);
  process.exit(1);
});
