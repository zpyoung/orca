import { BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import type { CustomPet } from '../../shared/pet-types'
import {
  applyCodexPetDefaults,
  readWebpDimensionsFromBuffer,
  type PetManifestLike,
  type ResolvedPetManifest
} from './pet-bundle'

// Why: pets are image-only — render natively via <img> (no 3D engine); main owns this format allowlist.
const IMAGE_FORMATS: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

function classifyFile(src: string): { mimeType: string; ext: string } | null {
  const ext = extname(src).toLowerCase()
  const mime = IMAGE_FORMATS[ext]
  if (!mime) {
    return null
  }
  return { mimeType: mime, ext }
}

// Why: keep the legacy `sidekicks` folder so existing user-uploaded pets keep rendering after the product rename.
function getPetsDir(): string {
  return join(app.getPath('userData'), 'sidekicks', 'custom')
}

const MAX_BYTES = 64 * 1024 * 1024 // 64 MB — generous but bounded so a user can't point at a multi-GB file and OOM the renderer when it builds a Blob URL.
const MAX_MANIFEST_BYTES = 64 * 1024 // pet.json is tiny by spec; cap to defend against a malicious bundle stuffing megabytes into the manifest.

function isSafeId(id: string): boolean {
  // UUIDs only — canonical path-traversal gate; storage ids are always main-generated, never from manifest.id.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function resolvePetFile(id: string, fileName: string, kind: 'image' | 'bundle'): string | null {
  if (!isSafeId(id)) {
    return null
  }
  const safeName = basename(fileName)
  const root = normalize(getPetsDir())
  let filePath: string
  if (kind === 'bundle') {
    // Bundle layout custom/<id>/<fileName>; fileName is the spritesheet basename — pet.json is main-only, never served.
    filePath = normalize(join(root, id, safeName))
    const bundleDir = normalize(join(root, id)) + sep
    if (!filePath.startsWith(bundleDir)) {
      return null
    }
    return filePath
  }
  // Legacy image layout custom/<id>.<ext>; filename must start with the id so the prefix check backstops the regex.
  if (!safeName.startsWith(`${id}.`)) {
    return null
  }
  filePath = normalize(join(root, safeName))
  if (!filePath.startsWith(root + sep)) {
    return null
  }
  return filePath
}

const PetManifestSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    displayName: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    spritesheetPath: z
      .string()
      .min(1)
      .max(255)
      // Why: belt-and-suspenders vs malicious manifests — downstream resolve+prefix check still runs as defense in depth.
      .refine(
        (p) => !p.includes('\0') && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..'),
        'invalid spritesheetPath'
      )
      .optional(),
    frame: z
      .object({
        width: z.number().int().positive().max(1024),
        height: z.number().int().positive().max(1024)
      })
      .optional(),
    fps: z.number().positive().max(60).optional(),
    defaultAnimation: z.string().min(1).max(64).optional(),
    animations: z
      .record(
        z.string().min(1).max(64),
        z.object({
          row: z.number().int().min(0).max(256),
          frames: z.number().int().positive().max(512),
          // Why: cap each hold at 60s so a bad manifest can't freeze the overlay.
          frameDurationsMs: z.array(z.number().positive().max(60_000)).max(512).optional()
        })
      )
      .optional()
  })
  // Why: .loose() ignores unknown manifest fields — generators emit metadata we don't consume; strict would reject imports.
  .loose()

type PetManifest = z.infer<typeof PetManifestSchema> & PetManifestLike

// Why: renderer IPC inputs are untrusted — validate shape here; resolvePetFile still gates the actual filesystem path.
const PetFileRequestSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  kind: z.enum(['image', 'bundle']).optional()
})

export function registerPetHandlers(): void {
  ipcMain.handle('pet:import', async (event): Promise<CustomPet | null> => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Pick pet',
      properties: ['openFile'],
      // Why: omit `apng` — macOS maps dialog extensions to UTIs, and apng's missing UTI can drop siblings like webp (APNG uses .png anyway).
      filters: [
        {
          name: 'Pet image',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
        }
      ]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const src = result.filePaths[0]
    const classified = classifyFile(src)
    if (!classified) {
      throw new Error('Unsupported file. Pick a PNG, APNG, JPG, GIF, WebP, or SVG.')
    }
    let srcStat: Awaited<ReturnType<typeof stat>>
    try {
      srcStat = await stat(src)
    } catch {
      throw new Error('Could not read the selected file.')
    }
    if (!srcStat.isFile()) {
      throw new Error('Selected path is not a file')
    }
    if (srcStat.size > MAX_BYTES) {
      throw new Error(
        `File is too large (${(srcStat.size / (1024 * 1024)).toFixed(1)} MB). Max is ${MAX_BYTES / (1024 * 1024)} MB.`
      )
    }

    const dir = getPetsDir()
    await mkdir(dir, { recursive: true })
    const id = randomUUID()
    // Why: keep the original extension in the on-disk name so pet:read can rebuild the Blob MIME without a separate lookup.
    const fileName = `${id}${classified.ext}`
    const dest = join(dir, fileName)
    try {
      await copyFile(src, dest)
    } catch {
      await rm(dest, { force: true }).catch(() => {})
      throw new Error('Could not save the pet.')
    }

    const rawLabel = basename(src, extname(src)).trim()
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 40) : 'Custom pet'
    return {
      id,
      label,
      fileName,
      mimeType: classified.mimeType,
      kind: 'image'
    }
  })

  ipcMain.handle(
    'pet:importPetBundle',
    async (event): Promise<CustomPet | null> => importPetBundle(event)
  )

  ipcMain.handle(
    'pet:read',
    async (
      _event,
      id: string,
      fileName: string,
      kind?: 'image' | 'bundle'
    ): Promise<ArrayBuffer | null> => {
      // Why: renderer inputs are untrusted; validate shape before any path logic.
      let parsed: z.infer<typeof PetFileRequestSchema>
      try {
        parsed = PetFileRequestSchema.parse({ id, fileName, kind })
      } catch {
        throw new Error('Invalid pet:read arguments')
      }
      // Why: default 'image' for backwards compat with pre-bundle persisted state.
      const filePath = resolvePetFile(parsed.id, parsed.fileName, parsed.kind ?? 'image')
      if (!filePath) {
        return null
      }
      try {
        const buf = await readFile(filePath)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch (error) {
        console.warn('[pet-overlay] pet:read failed', error)
        return null
      }
    }
  )

  ipcMain.handle(
    'pet:delete',
    async (_event, id: string, fileName: string, kind?: 'image' | 'bundle'): Promise<void> => {
      // Why: validate IPC inputs before any path logic.
      let parsed: z.infer<typeof PetFileRequestSchema>
      try {
        parsed = PetFileRequestSchema.parse({ id, fileName, kind })
      } catch {
        throw new Error('Invalid pet:delete arguments')
      }
      if (!isSafeId(parsed.id)) {
        return
      }
      if ((parsed.kind ?? 'image') === 'bundle') {
        // Why: defense in depth — verify path stays under pets root before recursive removal.
        const root = normalize(getPetsDir())
        const target = normalize(join(root, parsed.id))
        if (!target.startsWith(root + sep)) {
          return
        }
        try {
          await rm(target, { recursive: true, force: true })
        } catch (error) {
          console.warn('[pet-overlay] pet:delete (bundle) failed', error)
        }
        return
      }
      const filePath = resolvePetFile(parsed.id, parsed.fileName, 'image')
      if (!filePath) {
        return
      }
      try {
        await rm(filePath, { force: true })
      } catch (error) {
        console.warn('[pet-overlay] pet:delete failed', error)
      }
    }
  )
}
