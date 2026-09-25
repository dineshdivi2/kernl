import {readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {digestJson} from '@kernl/core'

export async function sourceFingerprint(root:string):Promise<string> {
  const files:Record<string,string>={}
  async function visit(relative:string) {
    for(const entry of await readdir(join(root,relative),{withFileTypes:true})) {
      if(['.git','node_modules','dist'].includes(entry.name))continue
      const path=relative?`${relative}/${entry.name}`:entry.name
      if(entry.isSymbolicLink())throw new Error('source fingerprint refuses symbolic links')
      if(entry.isDirectory())await visit(path)
      // Git text checkouts may use CRLF; fingerprint canonical source text,
      // not the host's checkout newline convention.
      else files[path]=digestJson((await readFile(join(root,path),'utf8')).replaceAll('\r\n','\n'))
    }
  }
  await visit('');return digestJson(files)
}

export async function executionFingerprint(root:string,fixture:string,catalogDigest:string) {
  return {catalogDigest,sourceDigest:await sourceFingerprint(fixture),runtimeDigest:await sourceFingerprint(join(root,'packages','runtime','src'))}
}
