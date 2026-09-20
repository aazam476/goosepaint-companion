// Re-implements the exact checksum logic from public/decoder.html's
// decode() function, so the gas station can independently verify a
// submission before spending real (if devnet) SOL on it. The client is
// never trusted here — anyone can call this endpoint directly with a
// crafted body, so every check the UI does gets redone from scratch
// against the raw 169-character code.
const ALPHA = "XAEFHKLMNPRTYJ479";
const N = 12;

export interface DecodeResult {
  ok: boolean;
  reason?: string;
  pixels: number[]; // length 144, values 0-16
}

export function decodeAndValidate(rawCode: string): DecodeResult {
  let s = (rawCode ?? "").toUpperCase().replace(/[^XAEFHKLMNPRTYJ479]/g, "");
  if (s.length === 170 && s[0] === "P") s = s.slice(1);
  if (s.length > 169) s = s.slice(s.length - 169);

  if (s.length !== 169) {
    return { ok: false, reason: `Expected 169 data characters, got ${s.length}.`, pixels: [] };
  }

  const v = s.split("").map((ch) => ALPHA.indexOf(ch));
  if (v.some((x) => x < 0)) {
    return { ok: false, reason: "Code contains a character outside the badge alphabet.", pixels: [] };
  }

  const cell = new Array(N * N).fill(0);
  const badRows: number[] = [];
  const badCols: number[] = [];

  for (let y = 0; y < N; y++) {
    let sum = 0;
    for (let x = 0; x < N; x++) {
      const val = v[y * 13 + x];
      cell[y * N + x] = val;
      sum += val;
    }
    const chk = v[y * 13 + 12];
    if (sum % 17 !== chk) badRows.push(y);
  }

  let total = 0;
  for (let x = 0; x < N; x++) {
    let sum = 0;
    for (let y = 0; y < N; y++) sum += cell[y * N + x];
    total += sum;
    const chk = v[156 + x];
    if (sum % 17 !== chk) badCols.push(x);
  }

  const totalOk = total % 17 === v[168];

  if (badRows.length || badCols.length || !totalOk) {
    return {
      ok: false,
      reason: `Checksum mismatch (rows: [${badRows.join(",")}], cols: [${badCols.join(",")}], total ok: ${totalOk}).`,
      pixels: cell,
    };
  }

  return { ok: true, pixels: cell };
}
