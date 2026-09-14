const fs = require('fs');
const path = require('path');

const PE_MACHINES = {
  x64: 0x8664,
  arm64: 0xaa64
};

const ELF_MACHINES = {
  x64: 62,
  arm64: 183
};

// These are supplied by supported Windows releases. Everything else imported
// by a sidecar must be present beside Mynda's copy of MPV.
const WINDOWS_SYSTEM_DLLS = new Set([
  'advapi32.dll', 'av.dll', 'avcore_1.dll', 'avcore_2.dll',
  'av44_3.dll', 'avrt.dll', 'bcrypt.dll', 'bcryptprimitives.dll',
  'cfgmgr32.dll', 'combase.dll', 'comctl32.dll', 'comdlg32.dll',
  'crypt32.dll', 'd2d1.dll', 'd3d11.dll', 'd3d12.dll',
  'd3dcompiler_47.dll', 'dbghelp.dll', 'dcomp.dll', 'dsound.dll',
  'dwmapi.dll', 'dxgi.dll', 'dxva2.dll', 'gdi32.dll', 'gdi32full.dll',
  'hid.dll', 'imm32.dll', 'iphlpapi.dll', 'kernel32.dll', 'kernelbase.dll',
  'ksuser.dll', 'mf.dll', 'mfplat.dll', 'mfreadwrite.dll', 'mfuuid.dll',
  'mmdevapi.dll', 'msacm32.dll', 'msvcp_win.dll', 'msvcrt.dll',
  'ncrypt.dll', 'normaliz.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll',
  'opengl32.dll', 'powrprof.dll', 'propsys.dll', 'psapi.dll',
  'rpcrt4.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll',
  'shlwapi.dll', 'ucrtbase.dll', 'user32.dll', 'userenv.dll',
  'usp10.dll', 'uuid.dll', 'version.dll', 'winhttp.dll', 'winmm.dll',
  'winspool.drv', 'wldap32.dll', 'ws2_32.dll', 'wtsapi32.dll'
]);

// A portable Linux bundle intentionally relies only on the ABI supplied by
// glibc and the kernel loader. Desktop, codec, subtitle, GPU-loader and audio
// libraries must be staged under media-tools/lib.
const LINUX_SYSTEM_LIBRARIES = new Set([
  'ld-linux-aarch64.so.1',
  'ld-linux-x86-64.so.2',
  'libc.so.6',
  'libdl.so.2',
  'libm.so.6',
  'libpthread.so.0',
  'librt.so.1',
  'linux-vdso.so.1'
]);

function walkFiles(directory, result = []) {
  if (!directory || !fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filename, result);
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}

function requireRange(buffer, offset, length, label) {
  if (!Buffer.isBuffer(buffer) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${label} is truncated or malformed`);
  }
}

function readCString(buffer, offset) {
  requireRange(buffer, offset, 1, 'PE string');
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  if (end === buffer.length) throw new Error('PE string is not null terminated');
  return buffer.toString('ascii', offset, end);
}

function parsePeHeader(buffer) {
  requireRange(buffer, 0, 64, 'PE file');
  if (buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('File does not have a DOS/PE header');
  const peOffset = buffer.readUInt32LE(0x3c);
  requireRange(buffer, peOffset, 24, 'PE header');
  if (buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    throw new Error('File does not have a valid PE signature');
  }

  const machine = buffer.readUInt16LE(peOffset + 4);
  const numberOfSections = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  requireRange(buffer, optionalOffset, optionalSize, 'PE optional header');
  const magic = buffer.readUInt16LE(optionalOffset);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported PE optional-header format');
  const pe32Plus = magic === 0x20b;
  const directoryOffset = optionalOffset + (pe32Plus ? 112 : 96);
  const numberOffset = optionalOffset + (pe32Plus ? 108 : 92);
  const numberOfDirectories = numberOffset + 4 <= optionalOffset + optionalSize ?
    buffer.readUInt32LE(numberOffset) : 0;
  const imageBase = pe32Plus ?
    Number(buffer.readBigUInt64LE(optionalOffset + 24)) :
    buffer.readUInt32LE(optionalOffset + 28);
  const sectionOffset = optionalOffset + optionalSize;
  requireRange(buffer, sectionOffset, numberOfSections * 40, 'PE section table');

  const sections = [];
  for (let index = 0; index < numberOfSections; index++) {
    const offset = sectionOffset + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20)
    });
  }

  function rvaToOffset(rva) {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        const offset = section.rawOffset + (rva - section.virtualAddress);
        if (offset < buffer.length) return offset;
      }
    }
    if (rva < buffer.length) return rva;
    throw new Error(`PE RVA 0x${rva.toString(16)} is outside every section`);
  }

  function dataDirectory(index) {
    if (numberOfDirectories <= index || directoryOffset + (index + 1) * 8 > optionalOffset + optionalSize) {
      return {rva: 0, size: 0};
    }
    return {
      rva: buffer.readUInt32LE(directoryOffset + index * 8),
      size: buffer.readUInt32LE(directoryOffset + index * 8 + 4)
    };
  }

  return {
    machine,
    pe32Plus,
    imageBase,
    rvaToOffset,
    dataDirectory
  };
}

function parsePeImports(buffer) {
  const header = parsePeHeader(buffer);
  const imports = [];

  function addImport(name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (normalized && !imports.includes(normalized)) imports.push(normalized);
  }

  const ordinary = header.dataDirectory(1);
  if (ordinary.rva) {
    let offset = header.rvaToOffset(ordinary.rva);
    const end = ordinary.size ? Math.min(buffer.length, offset + ordinary.size) : buffer.length;
    while (offset + 20 <= end) {
      const fields = [0, 4, 8, 12, 16].map(delta => buffer.readUInt32LE(offset + delta));
      if (fields.every(value => value === 0)) break;
      if (fields[3]) addImport(readCString(buffer, header.rvaToOffset(fields[3])));
      offset += 20;
    }
  }

  const delayed = header.dataDirectory(13);
  if (delayed.rva) {
    let offset = header.rvaToOffset(delayed.rva);
    const end = delayed.size ? Math.min(buffer.length, offset + delayed.size) : buffer.length;
    while (offset + 32 <= end) {
      const attributes = buffer.readUInt32LE(offset);
      const nameValue = buffer.readUInt32LE(offset + 4);
      if (attributes === 0 && nameValue === 0) break;
      if (nameValue) {
        const nameRva = attributes & 1 ? nameValue : nameValue - header.imageBase;
        addImport(readCString(buffer, header.rvaToOffset(nameRva)));
      }
      offset += 32;
    }
  }

  return imports;
}

function peArchitecture(buffer) {
  const machine = parsePeHeader(buffer).machine;
  return Object.keys(PE_MACHINES).find(name => PE_MACHINES[name] === machine) ||
    `unknown-0x${machine.toString(16)}`;
}

function isWindowsSystemDll(name, options = {}) {
  const value = String(name || '').toLowerCase();
  if (WINDOWS_SYSTEM_DLLS.has(value) ||
    value.startsWith('api-ms-win-') || value.startsWith('ext-ms-win-')) return true;
  const filesystem = options.fs || fs;
  const systemRoot = options.systemRoot || process.env.SystemRoot;
  return Boolean(systemRoot && filesystem.existsSync(path.join(systemRoot, 'System32', value)));
}

function assertWindowsBundle(stage, paths, arch, options = {}) {
  const readFile = options.readFile || (filename => fs.readFileSync(filename));
  const files = [paths.ffmpeg, paths.ffprobe, paths.mpv, ...walkFiles(stage).filter(filename =>
    /\.dll$/i.test(filename)
  )];
  const uniqueFiles = [...new Set(files.map(filename => path.resolve(filename)))];
  const bundledNames = new Set(uniqueFiles.map(filename => path.basename(filename).toLowerCase()));
  const missing = [];

  for (const filename of uniqueFiles) {
    const buffer = readFile(filename);
    const actualArch = peArchitecture(buffer);
    if (actualArch !== arch) {
      throw new Error(`${filename} has PE architecture ${actualArch}; ${arch} is required`);
    }
    for (const dependency of parsePeImports(buffer)) {
      if (/libdvdcss/i.test(dependency)) {
        missing.push(`${filename}: prohibited ${dependency}`);
      } else if (dependency === 'msys-2.0.dll') {
        missing.push(`${filename}: MSYS runtime ${dependency} is not allowed`);
      } else if (!isWindowsSystemDll(dependency, options) && !bundledNames.has(dependency)) {
        missing.push(`${filename}: missing ${dependency}`);
      }
    }
  }

  if (missing.length) {
    throw new Error(`Bundled Windows media tools have unresolved or prohibited DLL imports:\n${missing.join('\n')}`);
  }
  return {files: uniqueFiles.length, architecture: arch};
}

function parseElfHeader(buffer) {
  requireRange(buffer, 0, 20, 'ELF file');
  if (buffer[0] !== 0x7f || buffer.toString('ascii', 1, 4) !== 'ELF') {
    throw new Error('File does not have a valid ELF header');
  }
  const fileClass = buffer[4];
  const endian = buffer[5];
  if (fileClass !== 2) throw new Error('Only 64-bit ELF media tools are supported');
  if (endian !== 1 && endian !== 2) throw new Error('ELF file has an unknown byte order');
  const machine = endian === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  return {machine, fileClass, endian};
}

function elfArchitecture(buffer) {
  const machine = parseElfHeader(buffer).machine;
  return Object.keys(ELF_MACHINES).find(name => ELF_MACHINES[name] === machine) ||
    `unknown-${machine}`;
}

function parseElfDynamic(output) {
  const text = String(output || '');
  const needed = [];
  const searchPaths = [];
  for (const line of text.split(/\r?\n/)) {
    const neededMatch = line.match(/\(NEEDED\).*\[([^\]]+)\]/);
    if (neededMatch) needed.push(neededMatch[1]);
    const pathMatch = line.match(/\((?:RPATH|RUNPATH)\).*\[([^\]]*)\]/);
    if (pathMatch) searchPaths.push(...pathMatch[1].split(':').filter(Boolean));
  }
  return {needed, searchPaths};
}

function assertLinuxBundle(stage, paths, arch, runner, options = {}) {
  const readFile = options.readFile || (filename => fs.readFileSync(filename));
  const libraryDirectory = path.join(stage, 'lib');
  const libraries = walkFiles(libraryDirectory).filter(filename => /\.so(?:\.|$)/i.test(filename));
  const files = [...new Set([paths.ffmpeg, paths.ffprobe, paths.mpv, ...libraries]
    .map(filename => path.resolve(filename)))];
  const bundledNames = new Set(libraries.map(filename => path.basename(filename)));

  return Promise.all(files.map(async filename => {
    const actualArch = elfArchitecture(readFile(filename));
    if (actualArch !== arch) {
      throw new Error(`${filename} has ELF architecture ${actualArch}; ${arch} is required`);
    }
    const dynamic = await runner('/usr/bin/readelf', ['-d', filename]);
    const details = parseElfDynamic(dynamic.stdout);
    const unresolved = details.needed.filter(name =>
      !LINUX_SYSTEM_LIBRARIES.has(name) && !bundledNames.has(name)
    );
    if (unresolved.length) {
      throw new Error(`${filename} has unstaged Linux dependencies: ${unresolved.join(', ')}`);
    }
    if (details.needed.some(name => bundledNames.has(name)) &&
      !details.searchPaths.some(value => value.includes('$ORIGIN'))) {
      throw new Error(`${filename} has bundled dependencies but no app-relative ELF RUNPATH`);
    }
    const externalSearchPaths = details.searchPaths.filter(value => value.startsWith('/'));
    if (externalSearchPaths.length) {
      throw new Error(`${filename} contains external ELF search paths: ${externalSearchPaths.join(', ')}`);
    }
    if (details.needed.some(name => /libdvdcss/i.test(name))) {
      throw new Error(`${filename} imports prohibited libdvdcss`);
    }
    return filename;
  })).then(() => ({files: files.length, architecture: arch}));
}

module.exports = {
  ELF_MACHINES,
  LINUX_SYSTEM_LIBRARIES,
  PE_MACHINES,
  WINDOWS_SYSTEM_DLLS,
  assertLinuxBundle,
  assertWindowsBundle,
  elfArchitecture,
  isWindowsSystemDll,
  parseElfDynamic,
  parseElfHeader,
  parsePeHeader,
  parsePeImports,
  peArchitecture,
  walkFiles
};
