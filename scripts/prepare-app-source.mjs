import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(new URL('../apps/web/public/sources/',import.meta.url),{recursive:true});
const candidates=['package.json','package-lock.json','tsconfig.json','wrangler.jsonc','LICENSE','README.md','THIRD-PARTY-NOTICES.txt','.dockerignore','.gitignore','compose.yaml','engines.example.json','apps','packages','scripts','deploy','docs'];
const included=[];
for(const file of candidates)try{await access(new URL('../'+file,import.meta.url));included.push(file)}catch{}
const result=spawnSync('tar',['-czf','apps/web/public/sources/chessin-source.tar.gz','--exclude=node_modules','--exclude=dist','--exclude=.env','--exclude=.env.*','--exclude=*.log','--exclude=apps/web/public/sources','--exclude=apps/web/public/engines/19.0.0/*.wasm','--exclude=apps/web/public/engines/19.0.0/stockfish*.js',...included],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)throw Error('Could not package corresponding application source');
console.log('Packaged ChessIn corresponding source without binaries, caches, logs, or environment secrets.');
