import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const windows = { skip: process.platform !== "win32" };
const parser = fileURLToPath(new URL("./parse-evidence.ps1", import.meta.url));
const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");

function parts(bytes, sequence = 0, width = 128) {
  const encoded = Buffer.from(bytes).toString("base64");
  const fragments = encoded.match(new RegExp(`.{1,${width}}`, "g")) || [];
  return fragments.map((fragment, index) => `CS2_NATIVE_PART ${sequence} ${index}/${fragments.length} ${fragment}`);
}

function parse(log, { existing, timeout = 20000 } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cs2 evidence 中文 "));
  const input = path.join(temporary, "engine log.txt"), output = path.join(temporary, "frame evidence.jsonl");
  if (typeof log === "function") log(input);
  else fs.writeFileSync(input, Array.isArray(log) ? log.join("\r\n") : log);
  if (existing) fs.writeFileSync(output, existing);
  try {
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parser, "-LogPath", input, "-OutputPath", output], {
      windowsHide: true, encoding: "utf8", timeout,
    });
    const resultBytes = fs.existsSync(output) ? fs.readFileSync(output) : null;
    assert.ok(!fs.readdirSync(temporary).some(file => file.endsWith(".tmp")), "Temporary evidence must be removed after success or failure");
    return { ...result, bytes: resultBytes };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function accepts(log, expected) {
  const result = parse(log);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(result.bytes, Buffer.from(expected));
}

function rejects(log, pattern = /native evidence/i, options) {
  const result = parse(log, options);
  assert.notEqual(result.status, 0, "Parser unexpectedly accepted corrupted transport");
  assert.equal(result.bytes, null, "Failed validation must not publish partial evidence");
  assert.match(result.stderr, pattern);
}

test("console evidence reassembles timestamped fragments and preserves original JSON bytes", windows, () => {
  const first = ' {"type":"ready", "text":"中文 🚀\\n", "a":1.200e+01} ';
  const long = JSON.stringify({ type: "frame", players: Array.from({ length: 30 }, (_, i) => ({ steamid: String(i), name: `玩家 ${i} 🎯`, origin: [i, -i, 64] })) });
  const log = ["ordinary engine noise", ...parts(first, 0, 17).flatMap((line, i) => [`[2026-10-20 10:30:00.${i}] [Console] ${line}`, "unrelated channel update"]), ...parts(long, 1).map(line => `VProf: Console: ${line}`)];
  accepts(log, `${first}\n${long}\n`);
});

test("console evidence accepts exactly 256 fragments and 24576 decoded bytes", windows, () => {
  const json = `"${"x".repeat(24574)}"`;
  assert.equal(Buffer.byteLength(json), 24576);
  assert.equal(parts(json).length, 256);
  accepts(parts(json), `${json}\n`);
});

test("console evidence rejects a lost, duplicate or reordered part without publishing earlier records", windows, () => {
  const valid = parts('{"type":"ready"}');
  const split = parts(JSON.stringify({ text: "x".repeat(200) }), 1);
  rejects([...valid, ...split.slice(1)], /Lost, duplicate or reordered/);
  rejects([...valid, split[0], split[0], ...split.slice(1)], /Lost, duplicate or reordered/);
  rejects([...valid, split[1], split[0], ...split.slice(2)], /Lost, duplicate or reordered/);
});

test("console evidence rejects record sequence gaps and repeated records", windows, () => {
  rejects([...parts("{}"), ...parts("{}", 2)], /Lost, duplicate or reordered/);
  rejects([...parts("{}"), ...parts("{}")], /Lost, duplicate or reordered/);
});

test("console evidence rejects changing counts and incomplete final records", windows, () => {
  const split = parts(JSON.stringify({ text: "x".repeat(200) }));
  rejects([split[0], split[1].replace("/3 ", "/4 "), split[2]], /part count changed/);
  rejects(split.slice(0, -1), /Unterminated final/);
});

test("console evidence rejects malformed tags, trailing data and empty payloads", windows, () => {
  for (const line of ["CS2_NATIVE_PART 0 0/1 e30= junk", "CS2_NATIVE_PART 0 0/1 ", "CS2_NATIVE_PART 0 0/1 e30= ", "CS2_NATIVE_PARTX 0 0/1 e30=", "CS2_NATIVE_PART 0 -1/1 e30=", "CS2_NATIVE_PART 0 0/1 " + "a".repeat(129)]) {
    rejects([line], /Malformed native evidence/);
  }
});

test("console evidence rejects out-of-range transport numbers", windows, () => {
  for (const line of ["CS2_NATIVE_PART 0 0/0 e30=", "CS2_NATIVE_PART 0 0/257 e30=", "CS2_NATIVE_PART 0 1/1 e30=", "CS2_NATIVE_PART 999999999999999999999 0/1 e30="]) {
    rejects([line], /bounds|overflow/);
  }
});

test("console evidence rejects corrupted and noncanonical base64", windows, () => {
  for (const encoded of ["a", "e30===", "e3=0", "e31="]) {
    rejects([`CS2_NATIVE_PART 0 0/1 ${encoded}`], /base64/);
  }
});

test("console evidence rejects invalid UTF-8", windows, () => {
  rejects(parts(Buffer.from([0x22, 0xc0, 0xaf, 0x22])), /UTF-8/);
});

test("console evidence rejects malformed JSON and multi-line records", windows, () => {
  for (const json of ['{"a":}', '{"a":1,}', '[1,]', '{"a":1}suffix', '{"a":NaN}', '{"a":01}', '"bad\\x22"', '{"a":1/*comment*/}', '{\n"a":1}', 'true false']) {
    rejects(parts(json), /JSON record/);
  }
});

test("console evidence validates nested JSON and scalar grammar without normalizing bytes", windows, () => {
  const records = ['{"a":[],"A":{},"nested":[true,false,null,{"s":"\\u4e2d\\uD83D\\uDE80","n":-0.1e-23}]}', 'null', 'false', '123456789012345678901234567890', '[[],{}]'];
  accepts(records.flatMap((json, index) => parts(json, index)), records.map(json => json + "\n").join(""));
});

test("console evidence requires at least one complete record", windows, () => {
  rejects(["unrelated startup output", ""], /contains no records/);
});

test("console evidence never overwrites existing output", windows, () => {
  const existing = Buffer.from("keep existing evidence\n");
  const result = parse(parts("{}"), { existing });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not already exist/);
  assert.deepEqual(result.bytes, existing);
});

test("console evidence rejects the 100001st event without publishing partial output", windows, () => {
  rejects(input => {
    const descriptor = fs.openSync(input, "w");
    try {
      for (let offset = 0; offset <= 100000; offset += 1000) {
        const count = Math.min(1000, 100001 - offset);
        fs.writeSync(descriptor, Array.from({ length: count }, (_, index) => `CS2_NATIVE_PART ${offset + index} 0/1 e30=\n`).join(""));
      }
    } finally { fs.closeSync(descriptor); }
  }, /exceeds 100000 events/, { timeout: 120000 });
});

test("console evidence rejects decoded content beyond 64 MiB without publishing partial output", windows, () => {
  const json = `"${"x".repeat(24574)}"`;
  const encoded = Buffer.from(json).toString("base64").match(/.{1,128}/g);
  const records = Math.floor(64 * 1024 * 1024 / Buffer.byteLength(json)) + 1;
  rejects(input => {
    const descriptor = fs.openSync(input, "w");
    try {
      for (let sequence = 0; sequence < records; sequence++) {
        fs.writeSync(descriptor, encoded.map((fragment, index) => `CS2_NATIVE_PART ${sequence} ${index}/256 ${fragment}\n`).join(""));
      }
    } finally { fs.closeSync(descriptor); }
  }, /exceeds 64 MiB/, { timeout: 120000 });
});
