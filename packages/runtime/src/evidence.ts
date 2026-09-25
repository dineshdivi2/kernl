import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson, digestJson, sha256Hex } from '@kernl/core'

export interface EvidenceFile {
  path: string
  sha256: string
  bytes: number
}

export class EvidenceWriter {
  readonly outputDir: string
  private readonly projectRoot: string
  private readonly workspaceRoot: string
  private readonly written = new Map<string, EvidenceFile>()

  constructor(projectRoot: string, relativeOutput = 'artifacts/demo-run') {
    this.projectRoot = resolve(projectRoot)
    this.workspaceRoot = resolve(this.projectRoot, '..', '..')
    this.outputDir = resolve(this.projectRoot, relativeOutput)
  }

  /**
   * Evidence is intended to be shareable. Runtime paths remain available in
   * the live ledger, while exported artifacts use stable tokens so a Windows
   * username or checkout location cannot leak into the pack.
   */
  private portableText(content: string): string {
    let portable = content
    const replacements: Array<[string, string]> = [
      [pathToFileURL(this.projectRoot).href, '<KERNL_ROOT>'],
      [this.projectRoot.replaceAll('\\', '\\\\'), '<KERNL_ROOT>'],
      [this.projectRoot, '<KERNL_ROOT>'],
      [this.projectRoot.replaceAll('\\', '/'), '<KERNL_ROOT>'],
      [pathToFileURL(this.workspaceRoot).href, '<WORKSPACE_ROOT>'],
      [this.workspaceRoot.replaceAll('\\', '\\\\'), '<WORKSPACE_ROOT>'],
      [this.workspaceRoot, '<WORKSPACE_ROOT>'],
      [this.workspaceRoot.replaceAll('\\', '/'), '<WORKSPACE_ROOT>'],
    ]
    replacements.sort((left, right) => right[0].length - left[0].length)
    for (const [machinePath, token] of replacements) portable = portable.replaceAll(machinePath, token)
    return portable
      .replace(/[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+/gi, '<USER_HOME>')
      .replace(/[A-Za-z]:\/Users\/[^/\s"']+/gi, '<USER_HOME>')
  }

  private portableValue(value: unknown): unknown {
    if (typeof value === 'string') return this.portableText(value)
    if (Array.isArray(value)) return value.map(item => this.portableValue(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.portableValue(item)]))
    }
    return value
  }

  async initialize(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true })
  }

  async json(name: string, value: unknown): Promise<EvidenceFile> {
    const content = `${canonicalJson(this.portableValue(value))}\n`
    return this.text(name, content)
  }

  async jsonLines(name: string, values: readonly unknown[]): Promise<EvidenceFile> {
    return this.text(name, `${values.map(value => canonicalJson(this.portableValue(value))).join('\n')}\n`)
  }

  async text(name: string, content: string): Promise<EvidenceFile> {
    if (name.includes('..') || name.includes('\\') || name.startsWith('/')) {
      throw new Error(`unsafe evidence filename: ${name}`)
    }
    const path = join(this.outputDir, name)
    const portableContent = this.portableText(content)
    await writeFile(path, portableContent, 'utf8')
    const entry = { path: name, sha256: sha256Hex(portableContent), bytes: Buffer.byteLength(portableContent) }
    this.written.set(name, entry)
    return entry
  }

  entries(): EvidenceFile[] {
    return [...this.written.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  async indexExisting(): Promise<void> {
    await this.initialize()
    for (const entry of await readdir(this.outputDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === 'evidence-manifest.json') continue
      const content = await readFile(join(this.outputDir, entry.name))
      this.written.set(entry.name, { path: entry.name, sha256: sha256Hex(content), bytes: content.byteLength })
    }
  }

  coreDigest(): string {
    return digestJson(this.entries())
  }

  async manifest(metadata: Record<string, unknown>, generatedAt = new Date().toISOString()): Promise<{ manifest: unknown; digest: string }> {
    const manifest = {
      schemaVersion: '1.0',
      generatedAt,
      metadata,
      files: this.entries(),
    }
    await this.json('evidence-manifest.json', manifest)
    return { manifest, digest: digestJson(manifest) }
  }

  async verifyFiles(): Promise<void> {
    for (const entry of this.written.values()) {
      const content = await readFile(join(this.outputDir, entry.path))
      if (sha256Hex(content) !== entry.sha256) throw new Error(`evidence digest mismatch: ${entry.path}`)
    }
  }
}
