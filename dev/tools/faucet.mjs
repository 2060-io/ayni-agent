// Request devnet/testnet coins from the Verana faucet (verana-spec v4/verana-faucet) with an
// ADR-036 signature made from a mnemonic or a raw private key (hex).
// Usage: node faucet.mjs <faucet-base-url> <mnemonic|privkey-hex> [amount-uvna]
import { makeSignDoc, Secp256k1HdWallet, Secp256k1Wallet } from '@cosmjs/amino'
import { stringToPath } from '@cosmjs/crypto'
import { fromHex, toBase64 } from '@cosmjs/encoding'

const [, , base, mnemonic, amount] = process.argv
if (!base || !mnemonic) {
  console.error('usage: node faucet.mjs <faucet-base-url> <mnemonic> [amount-uvna]')
  process.exit(2)
}
// the second argument is a mnemonic, or the raw secp256k1 private key in hex (veranad keys export --unarmored-hex)
const wallet = /^[0-9a-fA-F]{64}$/.test(mnemonic)
  ? await Secp256k1Wallet.fromKey(fromHex(mnemonic), 'verana')
  : await Secp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: 'verana',
      hdPaths: [stringToPath("m/44'/118'/0'/0/0")],
    })
const [{ address, pubkey }] = await wallet.getAccounts()
const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
const info = await (await fetch(`${base}/v1/info`)).json()
const ch = await (await post('/v1/auth/challenge', { account: address })).json()
if (!ch.nonce) {
  console.error('challenge failed', ch)
  process.exit(1)
}
const data = toBase64(new TextEncoder().encode(`${info.auth.challengePrefix}${ch.nonce}`))
const signDoc = makeSignDoc(
  [{ type: 'sign/MsgSignData', value: { signer: address, data } }],
  { gas: '0', amount: [] },
  '',
  '',
  0,
  0
)
const { signature } = await wallet.signAmino(address, signDoc)
const tok = await (
  await post('/v1/auth/token', {
    account: address,
    pubKey: toBase64(pubkey),
    signature: signature.signature,
    nonce: ch.nonce,
  })
).json()
if (!tok.token) {
  console.error('token failed', tok)
  process.exit(1)
}
const res = await post('/v1/faucet', amount ? { amount } : {}, tok.token)
console.log(res.status, await res.text())
