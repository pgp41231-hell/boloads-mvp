import fs from 'node:fs/promises';
import path from 'node:path';
import { newState, id } from './model.js';

// Vercel allows writes only in /tmp. State is therefore temporary between cold starts.
const root=()=>path.resolve(process.env.DATA_DIR || (process.env.VERCEL?'/tmp/boloads-data':'./data'));
const locks=new Map();
export async function readState(sessionId) {
  await fs.mkdir(root(),{recursive:true});
  try {return JSON.parse(await fs.readFile(path.join(root(),`${sessionId}.json`),'utf8'));}
  catch(e) {if(e.code==='ENOENT') return newState(sessionId);throw e;}
}
export async function writeState(state) {
  await fs.mkdir(root(),{recursive:true});
  const target=path.join(root(),`${state.session.id}.json`);
  const temp=path.join(root(),`${state.session.id}.${id()}.tmp`);
  await fs.writeFile(temp,JSON.stringify(state,null,2),'utf8');
  await fs.rename(temp,target);
}
export async function transact(sessionId,fn) {
  const previous=locks.get(sessionId)||Promise.resolve();
  let release;
  const mine=new Promise(resolve=>release=resolve);
  const queued=previous.then(()=>mine);
  locks.set(sessionId,queued);
  await previous;
  try {
    const state=await readState(sessionId);
    const result=await fn(state);
    state.session.lastSeenAt=new Date().toISOString();
    await writeState(state);
    return {state,result};
  } finally {release();if(locks.get(sessionId)===queued) locks.delete(sessionId);}
}
