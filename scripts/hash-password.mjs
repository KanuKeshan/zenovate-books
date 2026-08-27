#!/usr/bin/env node
// Turns a password (read once from an env var, never as a CLI argument that
// could sit in shell history) into the "<salt-hex>:<hash-hex>" form
// LOCAL_AUTH_USERS expects. Usage:
//
//   PASSWORD='the real password' node scripts/hash-password.mjs
//
import { randomBytes, scryptSync } from 'node:crypto';

const password = process.env.PASSWORD;
if (!password) {
  console.error('Set PASSWORD in the environment first, e.g.:');
  console.error("  PASSWORD='correct horse battery staple' node scripts/hash-password.mjs");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
console.log(`${salt.toString('hex')}:${hash.toString('hex')}`);
