'use strict';

const path = require('path');

function sanitizeLogMessage(message) {
  return String(message ?? '').replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

class RollingFileLogger {
  constructor({ fs, directory, now = () => new Date() }) {
    if (!fs || typeof fs.appendFileSync !== 'function' || typeof fs.readdirSync !== 'function') {
      throw new Error('A filesystem implementation is required.');
    }
    if (typeof directory !== 'string' || !directory) throw new Error('A log directory is required.');
    this.fs = fs;
    this.directory = directory;
    this.now = now;
    this.filePath = null;
  }

  write(message) {
    const safeMessage = sanitizeLogMessage(message);
    if (!safeMessage) return;
    try {
      this.fs.mkdirSync(this.directory, { recursive: true });
      if (!this.filePath) {
        const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.join(this.directory, `quest-3-caster-${timestamp}.txt`);
        this.prune();
      }
      this.fs.appendFileSync(this.filePath, `[${this.now().toISOString()}] ${safeMessage}\r\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.error('Unable to write Quest 3 Caster log file.', error);
    }
  }

  prune() {
    try {
      const files = this.fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^quest-3-caster-.*\.txt$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const fileName of files.slice(29)) {
        this.fs.unlinkSync(path.join(this.directory, fileName));
      }
    } catch (error) {
      console.error('Unable to prune Quest 3 Caster logs.', error);
    }
  }
}

module.exports = { RollingFileLogger, sanitizeLogMessage };
