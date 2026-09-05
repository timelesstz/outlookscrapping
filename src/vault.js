// Passphrase-encrypted vault for the AI API key. The ciphertext can safely
// live in the public site (vault.json); only the admin passphrase unlocks it.
// AES-256-GCM with a key derived by PBKDF2-SHA256 (600k iterations).
const ITERATIONS = 600000
const enc = new TextEncoder()
const dec = new TextDecoder()
const subtle = globalThis.crypto.subtle
const b64 = (u8) => btoa(Array.from(u8, (b) => String.fromCharCode(b)).join(''))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptVault(passphrase, secret, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, iterations)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret)))
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct), created: new Date().toISOString() }
}

export async function decryptVault(passphrase, vault) {
  if (!vault || !vault.ct) throw new Error('No vault present')
  const key = await deriveKey(passphrase, unb64(vault.salt), vault.iterations || ITERATIONS)
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct))
    return dec.decode(pt)
  } catch {
    throw new Error('Wrong passphrase')
  }
}

/** Fetch vault.json shipped with the site (null if absent). */
export async function loadVaultFile() {
  try {
    const r = await fetch('./vault.json', { cache: 'no-store' })
    if (!r.ok) return null
    const v = await r.json()
    return v && v.ct && v.salt && v.iv ? v : null
  } catch { return null }
}

const WORDS = 'amber anchor apple arrow atlas badge baker basil beach bison blade bloom brass bridge cactus camel candle canyon cedar chalk cherry cloud cobalt comet copper coral crane crystal delta desert dune eagle ember falcon fern flame forest fossil galaxy garden ginger glacier granite harbor hawk hazel heron honey ivory jade jasper jungle kayak kestrel lagoon lantern lemon lily lotus lunar maple marble meadow meteor mint mosaic nectar nebula nickel north oasis ocean olive onyx opal orbit orchid otter oyster panda pearl pepper pine planet plum polar poplar prism quartz raven reef river rocket ruby saffron sage salmon sandal sapphire sierra silver sparrow spruce stone storm summit sunny tango terra thunder tiger topaz tulip tundra velvet violet walnut willow winter yellow zebra zenith'.split(' ')
/** Memorable but strong: 4 random words + a number (~ 40+ bits). */
export function generatePassphrase() {
  const r = crypto.getRandomValues(new Uint32Array(5))
  return `${WORDS[r[0] % WORDS.length]}-${WORDS[r[1] % WORDS.length]}-${WORDS[r[2] % WORDS.length]}-${WORDS[r[3] % WORDS.length]}-${10 + (r[4] % 90)}`
}
