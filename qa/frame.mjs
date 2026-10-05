/* A plain test picture for the QA scripts: an RGB PNG with a few colored bands, built with node:zlib only. */
import zlib from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** A width x height PNG: a dark header bar over light columns, so marks and crops have something to land on. */
export function framePng(width = 1600, height = 900) {
	const row = width * 3 + 1;
	const raw = Buffer.alloc(row * height);
	for (let y = 0; y < height; y++) {
		raw[y * row] = 0;
		for (let x = 0; x < width; x++) {
			const i = y * row + 1 + x * 3;
			const header = y < height / 10;
			const band = Math.floor(x / (width / 6)) % 2;
			const v = header ? 40 : band ? 236 : 214;
			raw[i] = v;
			raw[i + 1] = header ? 50 : v;
			raw[i + 2] = header ? 80 : 245;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
