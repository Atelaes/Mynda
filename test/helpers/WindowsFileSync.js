const fs = require('fs');

// Exercise Windows' writable-handle requirement while retaining real file
// writes, flushes, copies, and cleanup on every host. Suites run serially in
// separate processes; always restore this narrow hook after the operation.
async function withWindowsFileSync(operation) {
  const originalOpen = fs.promises.open;
  const policy = {syncs: 0, failWith: null};
  fs.promises.open = async function open(filename, flags, ...args) {
    const handle = await originalOpen.call(fs.promises, filename, flags, ...args);
    const originalSync = handle.sync.bind(handle);
    const writable = typeof flags === 'number' ?
      Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) : /[wa+]/.test(flags);
    handle.sync = async () => {
      policy.syncs++;
      const code = !writable ? 'EPERM' : policy.failWith;
      if (code) throw Object.assign(new Error(`${code}: simulated Windows file flush failure`), {code});
      return originalSync();
    };
    return handle;
  };
  try { return await operation(policy); }
  finally { fs.promises.open = originalOpen; }
}

module.exports = {withWindowsFileSync};
