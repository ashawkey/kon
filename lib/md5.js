// Compact MD5 (hex) — needed for Bilibili wbi request signing.
export function md5(string) {
  function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
  function add(x, y) {
    const x4 = x & 0x40000000, y4 = y & 0x40000000, x8 = x & 0x80000000, y8 = y & 0x80000000;
    const r = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
    if (x4 & y4) return r ^ 0x80000000 ^ x8 ^ y8;
    if (x4 | y4) return (r & 0x40000000) ? (r ^ 0xC0000000 ^ x8 ^ y8) : (r ^ 0x40000000 ^ x8 ^ y8);
    return r ^ x8 ^ y8;
  }
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  const step = (fn) => (a, b, c, d, x, s, ac) => add(rotl(add(a, add(add(fn(b, c, d), x), ac)), s), b);
  const FF = step(F), GG = step(G), HH = step(H), II = step(I);
  function toWords(str) {
    const len = str.length;
    const n = (((len + 8 - ((len + 8) % 64)) / 64) + 1) * 16;
    const w = new Array(n - 1).fill(0);
    let i = 0;
    while (i < len) { w[(i - (i % 4)) / 4] |= str.charCodeAt(i) << ((i % 4) * 8); i++; }
    w[(i - (i % 4)) / 4] |= 0x80 << ((i % 4) * 8);
    w[n - 2] = len << 3; w[n - 1] = len >>> 29;
    return w;
  }
  const hex = (v) => {
    let s = "";
    for (let j = 0; j <= 3; j++) { const b = (v >>> (j * 8)) & 255; s += ("0" + b.toString(16)).slice(-2); }
    return s;
  };
  string = unescape(encodeURIComponent(string));
  const x = toWords(string);
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    a = FF(a, b, c, d, x[k], S[0], 0xD76AA478); d = FF(d, a, b, c, x[k + 1], S[1], 0xE8C7B756); c = FF(c, d, a, b, x[k + 2], S[2], 0x242070DB); b = FF(b, c, d, a, x[k + 3], S[3], 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], S[0], 0xF57C0FAF); d = FF(d, a, b, c, x[k + 5], S[1], 0x4787C62A); c = FF(c, d, a, b, x[k + 6], S[2], 0xA8304613); b = FF(b, c, d, a, x[k + 7], S[3], 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], S[0], 0x698098D8); d = FF(d, a, b, c, x[k + 9], S[1], 0x8B44F7AF); c = FF(c, d, a, b, x[k + 10], S[2], 0xFFFF5BB1); b = FF(b, c, d, a, x[k + 11], S[3], 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], S[0], 0x6B901122); d = FF(d, a, b, c, x[k + 13], S[1], 0xFD987193); c = FF(c, d, a, b, x[k + 14], S[2], 0xA679438E); b = FF(b, c, d, a, x[k + 15], S[3], 0x49B40821);
    a = GG(a, b, c, d, x[k + 1], S[4], 0xF61E2562); d = GG(d, a, b, c, x[k + 6], S[5], 0xC040B340); c = GG(c, d, a, b, x[k + 11], S[6], 0x265E5A51); b = GG(b, c, d, a, x[k], S[7], 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], S[4], 0xD62F105D); d = GG(d, a, b, c, x[k + 10], S[5], 0x02441453); c = GG(c, d, a, b, x[k + 15], S[6], 0xD8A1E681); b = GG(b, c, d, a, x[k + 4], S[7], 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], S[4], 0x21E1CDE6); d = GG(d, a, b, c, x[k + 14], S[5], 0xC33707D6); c = GG(c, d, a, b, x[k + 3], S[6], 0xF4D50D87); b = GG(b, c, d, a, x[k + 8], S[7], 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], S[4], 0xA9E3E905); d = GG(d, a, b, c, x[k + 2], S[5], 0xFCEFA3F8); c = GG(c, d, a, b, x[k + 7], S[6], 0x676F02D9); b = GG(b, c, d, a, x[k + 12], S[7], 0x8D2A4C8A);
    a = HH(a, b, c, d, x[k + 5], S[8], 0xFFFA3942); d = HH(d, a, b, c, x[k + 8], S[9], 0x8771F681); c = HH(c, d, a, b, x[k + 11], S[10], 0x6D9D6122); b = HH(b, c, d, a, x[k + 14], S[11], 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], S[8], 0xA4BEEA44); d = HH(d, a, b, c, x[k + 4], S[9], 0x4BDECFA9); c = HH(c, d, a, b, x[k + 7], S[10], 0xF6BB4B60); b = HH(b, c, d, a, x[k + 10], S[11], 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], S[8], 0x289B7EC6); d = HH(d, a, b, c, x[k], S[9], 0xEAA127FA); c = HH(c, d, a, b, x[k + 3], S[10], 0xD4EF3085); b = HH(b, c, d, a, x[k + 6], S[11], 0x04881D05);
    a = HH(a, b, c, d, x[k + 9], S[8], 0xD9D4D039); d = HH(d, a, b, c, x[k + 12], S[9], 0xE6DB99E5); c = HH(c, d, a, b, x[k + 15], S[10], 0x1FA27CF8); b = HH(b, c, d, a, x[k + 2], S[11], 0xC4AC5665);
    a = II(a, b, c, d, x[k], S[12], 0xF4292244); d = II(d, a, b, c, x[k + 7], S[13], 0x432AFF97); c = II(c, d, a, b, x[k + 14], S[14], 0xAB9423A7); b = II(b, c, d, a, x[k + 5], S[15], 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], S[12], 0x655B59C3); d = II(d, a, b, c, x[k + 3], S[13], 0x8F0CCC92); c = II(c, d, a, b, x[k + 10], S[14], 0xFFEFF47D); b = II(b, c, d, a, x[k + 1], S[15], 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], S[12], 0x6FA87E4F); d = II(d, a, b, c, x[k + 15], S[13], 0xFE2CE6E0); c = II(c, d, a, b, x[k + 6], S[14], 0xA3014314); b = II(b, c, d, a, x[k + 13], S[15], 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], S[12], 0xF7537E82); d = II(d, a, b, c, x[k + 11], S[13], 0xBD3AF235); c = II(c, d, a, b, x[k + 2], S[14], 0x2AD7D2BB); b = II(b, c, d, a, x[k + 9], S[15], 0xEB86D391);
    a = add(a, AA); b = add(b, BB); c = add(c, CC); d = add(d, DD);
  }
  return (hex(a) + hex(b) + hex(c) + hex(d)).toLowerCase();
}
