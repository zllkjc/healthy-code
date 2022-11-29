import { task, build, watch, serve } from './buildrunner.mjs';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import HTMLMinifier from 'html-minifier';
import CleanCSS from 'clean-css';
import UglifyJS from 'uglify-js';
import sass from 'sass';
import _ from 'lodash';
import { globby } from 'globby';

const htmlOptions = {
  collapseWhitespace: true,
  removeComments: true,
  removeOptionalTags: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeTagWhitespace: true,
  useShortDoctype: true,
  minifyCSS: true,
  minifyJS: true,
};

const cssCleanner = new CleanCSS();

const isDev = process.argv.includes('--dev');

task('src/common/nav.scss')
  .transform((contents, ctx) => {
    const result = sass.compileString(contents.toString(), { loadPaths: [ctx.path()], sourceMap: false });
    ctx.watch(result.loadedUrls.map(fileURLToPath), { markAsBuilt: true });
    return result.css;
  })
  .staged('src/common/nav.css');

const selfDestroyingSW = `
self.addEventListener('install', function(e) {
  self.skipWaiting();
});
self.addEventListener('activate', function(e) {
  self.registration.unregister()
    .then(function() {
      return self.clients.matchAll();
    })
    .then(function(clients) {
      clients.forEach(client => client.navigate(client.url))
    });
});`

task('src/service-worker.js')
  .transform((contents) => isDev ? selfDestroyingSW : contents)
  .staged();

if(!isDev) {
  task('src/**/*.html')
    .transform((contents) => HTMLMinifier.minify(contents.toString(), htmlOptions));

  task('src/**/*.css')
    .transform((contents) => cssCleanner.minify(contents.toString()).styles);

  task('src/**/*.js')
    .transform((contents) => UglifyJS.minify(contents.toString()).code);
}

// copy rest files
task(['src/**/*']);

await build('build/');

if(!isDev) {
  const files = await globby(['build/**/*', '!build/service-worker.js']);
  const assets = _.groupBy(files.map(file => file.substring(6)), // strip 'build/'
    file => file.includes(path.sep) ? file.split(path.sep, 1)[0] : 'root'); 
   
  await appendFile('build/service-worker.js', `;assets = ${JSON.stringify(assets)}`);
}

if(process.argv.includes('--watch')) {
  watch();
}

if(process.argv.includes('--serve')) {
  serve();
} else if(process.argv.includes('--serve-https')) {
  serve({
    https: {
      key: './tools/local-https/key.pem',
      cert: './tools/local-https/cert.pem'
    }
  });
}
