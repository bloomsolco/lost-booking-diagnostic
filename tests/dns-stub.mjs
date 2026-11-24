// tests/dns-stub.mjs — OPTIONAL preload for sandboxes without DNS:
//   node --import ./dns-stub.mjs local-harness.mjs
// Resolves ONLY the IANA-reserved example.com / example.net / example.org test hosts to their
// public documentation address, so the SSRF pre-check passes exactly as it does with real DNS.
// Every other hostname goes to the real resolver. Not used by any deployed code.
import dns from "node:dns/promises";
const real = dns.lookup.bind(dns);
const TEST_HOST = /(^|\.)example\.(com|net|org)$/i;
dns.lookup = async (host, opts) => {
  if (TEST_HOST.test(host)) {
    const a = { address: "93.184.216.34", family: 4 };
    return opts && opts.all ? [a] : a;
  }
  return real(host, opts);
};
