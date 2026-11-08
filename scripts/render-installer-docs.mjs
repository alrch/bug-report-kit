// Small dependency-free reading view for the five authored installer documents.
// It intentionally accepts no arbitrary source path or embedded HTML.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=resolve(root,'docs/installer');
const documents=['PASSPORT','PRODUCT_GUIDE','PROJECT_OVERVIEW','ADAPTER','evidence-2026-11-02'];
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const anchor=s=>s.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu,'').replaceAll(' ','-');
function link(target){
 const [path,hash]=target.split('#');
 if(!path)return '#'+hash;
 if(documents.some(name=>path===name+'.md'))return path.replace(/\.md$/,'.html')+(hash?'#'+hash:'');
 return /^(https?:|mailto:)/.test(path)?target:'../'+target;
}
function inline(text){
 // Author-owned Markdown only. Escape first so HTML and attribute injection cannot pass.
 return escape(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,target)=>`<a href="${link(target)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
}
function render(source){
 let output='',paragraph=[],list=null,code=null;
 const flush=()=>{if(paragraph.length){output+='<p>'+inline(paragraph.join(' '))+'</p>\n';paragraph=[]}};
 const closeList=()=>{if(list){output+=`</${list}>\n`;list=null}};
 for(const line of source.split('\n')){
  if(line.startsWith('```')){flush();closeList();if(code===null)code=[];else{output+='<pre><code>'+escape(code.join('\n'))+'</code></pre>\n';code=null}continue}
  if(code!==null){code.push(line);continue}
  const heading=/^(#{1,4}) (.*)$/.exec(line);
  const bullet=/^(?:- |(\d+)\. )(.*)$/.exec(line);
  if(heading){flush();closeList();const n=heading[1].length;output+=`<h${n} id="${anchor(heading[2])}">${inline(heading[2])}</h${n}>\n`}
  else if(bullet){flush();const kind=bullet[1]?'ol':'ul';if(list!==kind){closeList();list=kind;output+=`<${kind}>\n`}output+='<li>'+inline(bullet[2])+'</li>\n'}
  else if(!line.trim()){flush();closeList()}
  else if(list && /^\s+/.test(line)){output=output.replace(/<\/li>\n$/,' '+inline(line.trim())+'</li>\n')}
  else {closeList();paragraph.push(line.trim())}
 }
 flush();closeList();return output;
}
mkdirSync(resolve(directory,'readable'),{recursive:true});
for(const name of documents){
 const source=readFileSync(resolve(directory,name+'.md'),'utf8');
 const title=source.split('\n')[0].replace(/^# /,'');
 const body=render(source);
 writeFileSync(resolve(directory,'readable',name+'.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:3rem auto;padding:0 1.5rem;max-width:76ch;font:17px/1.65 system-ui,sans-serif;color:#243040;background:#fafbfc}h1,h2,h3{line-height:1.25;color:#13202e}h2{margin-top:2.3rem}a{color:#075bb5}code{font-size:.9em;background:#edf1f5;padding:.15em .3em;overflow-wrap:anywhere}pre{overflow:auto;padding:1rem;background:#edf1f5}li{margin:.5em 0}p{margin:1em 0}</style><main>${body}</main></html>\n`);
}
let count=0;
for(const file of [...documents.map(n=>resolve(directory,n+'.md')),resolve(root,'AGENTS.md')]){
 const source=readFileSync(file,'utf8');
 for(const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
  const [path,fragment]=match[1].split('#');if(/^(https?:|mailto:)/.test(path))continue;
  const destination=path?resolve(dirname(file),path):file;
  if(!existsSync(destination))throw Error(`Missing link in ${basename(file)}`);
  if(fragment&&destination.endsWith('.md')){
   const text=readFileSync(destination,'utf8');
   if(![...text.matchAll(/^#+ (.+)$/gm)].some(m=>anchor(m[1])===fragment))throw Error(`Missing anchor in ${basename(file)}`);
  }
  count++;
 }
}
console.log(JSON.stringify({ok:true,documents:documents.length,localLinks:count}));
