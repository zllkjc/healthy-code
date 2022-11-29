import { globby } from 'globby';
import micromatch from 'micromatch';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { createServer } from 'http-server';

const tasks = [];

const STAGED_KEEP = Symbol();

class TaskRegister {
  constructor(src) {
    tasks.push({ src });
    this.index = tasks.length - 1;
  }

  transform(cb) {
    tasks[this.index].transform = cb;
    return this;
  }

  staged(val) {
    tasks[this.index].staged = val || STAGED_KEEP;
    return this;
  }
}

export function task(src) {
  return new TaskRegister(src);
}

function transformStagedFilename(staged, file) {
  if(staged === STAGED_KEEP) {
    return file;
  } else if(typeof staged === 'string' || staged instanceof String) {
    return staged.toString();
  } else if(typeof staged === 'function') {
    return staged(file);
  }

  console.error('unrecognized staged type', typeof(staged));
}

export function replaceExtension(file, newExtension) {
  return path.parse(file).name + newExtension;
}

const history = new Map();
const watches = new Map();
let basePath = 'dist/';

async function getFileContent(file) {
  if(history.has(file)) {
    const item = history.get(file);
    if(item.content != null) {
      return item.content;
    }
  }

  return await readFile(file);
}

function getHistory(file) {
  if(!history.has(file)) history.set(file, {});
  return history.get(file);
}

function getWatch(file) {
  if(!watches.has(file)) watches.set(file, {
    /**
     * task indexes
     */
    passes: [],

    /**
     * use another file as task entry
     */
    entry: '',

    /**
     * execute passes and redirect to another file
     */
    redirect: '',
  });
  return watches.get(file);
}

class TaskContext {
  constructor(index, file) {
    this.index = index;
    this.file = file;
  }

  file() { return this.file; }

  path() { return path.dirname(this.file); }

  watch(file, { markAsBuilt = false } = {}) {
    const files = (Array.isArray(file) ? file : files).map(f => path.relative('.', f));

    for(const f of files) {
      getWatch(f).entry = this.file;
      getWatch(f).passes.push(this.index);
      
      if(markAsBuilt) {
        getHistory(f).built = true;

        console.log(`[-] dependency ${f} marked as built`);
      }
    }
  }
}

async function doTask(index, file, addToWatch) {
  const task = tasks[index];
  const { dir } = path.parse(file);
  const destinationFolder = dir.replace(dir.split('/')[0], basePath);

  await mkdir(destinationFolder, { recursive: true });
  const outFile = path.join(destinationFolder, path.basename(file));

  const isDirectCopy = !task.staged && !task.transform && getHistory(file).content == null;
  if(isDirectCopy) {
    await copyFile(file, outFile);
    console.log(`[>] ${file} → ${outFile}`);
    return;
  }
  
  let content = await getFileContent(file);
  if(task.transform) {
    const ctx = new TaskContext(index, file);
    content = task.transform(content, ctx);
  }

  if(task.staged) {
    const newFile = transformStagedFilename(task.staged, file);
    getHistory(newFile).built = false;
    getHistory(newFile).content = content;
    addToWatch && getWatch(file).passes.push(index);

    if(newFile !== file) {
      // set old file built so that it won't build again
      getHistory(file).built = true;
      addToWatch && (getWatch(file).redirect = newFile);

      console.log(`[^] ${file} → ${newFile} staged`);
    } else {
      console.log(`[^] ${file} staged`);
    }
  } else {
    await writeFile(outFile, content);
    getHistory(file).built = true;
    addToWatch && getWatch(file).passes.push(index);

    console.log(`[+] ${file} → ${outFile}`);
  }
}

export async function build(outPath) {
  basePath = outPath;
  history.clear();
  watches.clear();

  for(let i = 0; i < tasks.length; i++) {
    const files = [...new Set(
      (await globby(tasks[i].src)) // glob files
        .concat(micromatch([...history.keys()], tasks[i].src)) // staged files
        .filter(file => !getHistory(file).built)
    )];

    await Promise.all(files.map(file => doTask(i, file, true)));
  }

  console.log('[✓] build completed.');
}

async function onFileChanged(file) {
  let curFile = file;
  
  while(curFile) {
    const watch = watches.get(curFile);

    if(watch.entry) {
      curFile = watch.entry;
      continue;
    }

    for(let pass of watch.passes) {
      await doTask(pass, curFile, false);
    }

    if(watch.redirect) {
      curFile = watch.redirect;
      continue;
    }

    curFile = '';
  }
}

export function watch() {
  // all built files and dependencies
  chokidar.watch([...watches.keys()], { ignoreInitial: true })
    .on('change', onFileChanged);

  // watch new files
  for(let i = 0; i < tasks.length; i++) {
    chokidar.watch(tasks[i].src, { ignoreInitial: true })
      .on('add', file => doTask(i, file, true));
  }

  console.log(`[ ] watching file changes`);
}

export function serve({ host = '0.0.0.0', port = 3001, https } = {}) {
  createServer({
    root: basePath,
    https,
  }).listen(port, host);

  console.log(`[ ] server started on ${https ? 'https' : 'http'}://${host}:${port}`);
}
