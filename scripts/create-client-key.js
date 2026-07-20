#!/usr/bin/env node
import { createClient, VALID_TIERS } from "../src/utils/clients.js";

const [, , name, tierArg] = process.argv;
const tier = (tierArg || "free").toLowerCase();

if (!name) {
  console.error("Pemakaian: npm run create-key -- <nama> [free|premium|admin]");
  console.error('Contoh   : npm run create-key -- "budi" premium');
  process.exit(1);
}
if (!VALID_TIERS.includes(tier)) {
  console.error(`Tier gak valid: '${tier}'. Pilihan: ${VALID_TIERS.join(", ")}`);
  process.exit(1);
}

try {
  const client = createClient({ name, tier });
  console.log(`Client baru dibuat: "${client.name}" (tier: ${client.tier})`);
  console.log(`API key: ${client.apiKey}`);
  console.log(`Client kirim request dengan header:  x-api-key: ${client.apiKey}`);
  console.log("Langsung aktif, gak perlu restart server (clients.json dibaca ulang tiap request).");
  console.log("Key ini & yang lain juga bisa dikelola lewat panel admin -> client-manager.html.");
} catch (err) {
  console.error(`Gagal membuat client: ${err.message}`);
  process.exit(1);
}
