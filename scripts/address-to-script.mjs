import { addressToScript } from "../packages/wallet-core/dist/address.js";
import { PEPEPOW } from "../packages/wallet-core/dist/network.js";

const address = process.argv[2];
if (!address) {
  console.error("Usage: node scripts/address-to-script.mjs <address>");
  process.exit(1);
}

try {
  const info = addressToScript(address.trim(), PEPEPOW);
  const scriptHex = Buffer.from(info.script).toString("hex");
  console.log(`type=${info.type} script=${scriptHex} len=${info.script.length}`);
} catch (err) {
  console.error(`error=${err?.message || String(err)}`);
  process.exit(1);
}
