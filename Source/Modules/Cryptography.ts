import crypto from "crypto";
import { IV, KEY } from "./Constants";

async function ImportKey() {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(KEY), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

export async function Encrypt(plaintext: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await ImportKey();

  const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: enc.encode(IV) }, key, enc.encode(plaintext));

  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

export async function Decrypt(encryptedData: string): Promise<string> {
  const enc = new TextEncoder();
  const data = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
  const key = await ImportKey();

  const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.encode(IV) }, key, data);

  return new TextDecoder().decode(decrypted);
}
