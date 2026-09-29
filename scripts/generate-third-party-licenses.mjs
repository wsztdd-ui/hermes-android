#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rendererRoot = resolve(process.argv[2] ?? process.env.HERMES_ROOT ?? '/tmp/hermes-agent')
const outputPath = resolve(process.argv[3] ?? 'THIRD_PARTY_LICENSES.json')
const textOutputPath = resolve(process.argv[4] ?? outputPath.replace(/\.json$/i, '.txt'))
const targetOS = process.env.LICENSE_TARGET_OS ?? process.platform
const targetCPU = process.env.LICENSE_TARGET_CPU ?? process.arch
const lockPath = join(rendererRoot, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const overridesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'THIRD_PARTY_LICENSE_OVERRIDES.json')
const licenseOverrides = JSON.parse(readFileSync(overridesPath, 'utf8'))
if (lock.lockfileVersion !== 3 || !lock.packages?.['apps/desktop']) {
  throw new Error(`Expected npm v3 lockfile with apps/desktop workspace: ${lockPath}`)
}

const packages = lock.packages
const queue = ['apps/desktop']
const visited = new Set()
const thirdParty = new Map()
const unresolved = new Set()
const licenseTexts = new Map()
const missingLicenseTexts = new Set()

function readLicenseText(packageDir) {
  if (!existsSync(packageDir)) return null
  const names = readdirSync(packageDir)
  const licenseName = names.find(name => /^(license|licence|copying|notice)(\.|-|$)/i.test(name))
  if (!licenseName) return null
  const filePath = join(packageDir, licenseName)
  try {
    return { name: licenseName, text: readFileSync(filePath, 'utf8').trim() }
  } catch {
    return null
  }
}

function findDependency(from, name) {
  let current = from
  while (current) {
    const candidate = posix.join(current, 'node_modules', name)
    if (packages[candidate] && packageMatchesTarget(packages[candidate])) return candidate
    const segments = current.split('/')
    const nodeModulesIndex = segments.lastIndexOf('node_modules')
    current = nodeModulesIndex >= 0 ? segments.slice(0, nodeModulesIndex).join('/') : dirname(current)
    if (current === '.') current = ''
  }
  const rootCandidate = posix.join('node_modules', name)
  return packages[rootCandidate] && packageMatchesTarget(packages[rootCandidate]) ? rootCandidate : null
}

function packageMatchesTarget(entry) {
  const allows = (values, target) => {
    if (!Array.isArray(values) || values.length === 0) return true
    const excluded = values.some(value => value.startsWith('!') && value.slice(1) === target)
    if (excluded) return false
    const included = values.filter(value => !value.startsWith('!'))
    return included.length === 0 || included.includes(target)
  }
  return allows(entry.os, targetOS) && allows(entry.cpu, targetCPU)
}

while (queue.length) {
  const key = queue.pop()
  if (visited.has(key)) continue
  visited.add(key)

  const entry = packages[key]
  if (!entry) continue
  const resolvedKey = entry.link ? entry.resolved : key
  const metadata = packages[resolvedKey] ?? entry

  if (key.includes('node_modules/') && !entry.link) {
    const name = metadata.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const version = metadata.version ?? 'unknown'
    const override = licenseOverrides[`${name}@${version}`]
    const licenseText = readLicenseText(join(rendererRoot, key))
    if (licenseText?.text) {
      const packageName = `${name}@${version}`
      const textEntry = licenseTexts.get(licenseText.text) ?? { text: licenseText.text, packages: [] }
      textEntry.packages.push({ name: packageName, file: licenseText.name })
      licenseTexts.set(licenseText.text, textEntry)
    } else {
      missingLicenseTexts.add(`${name}@${version}`)
    }
    thirdParty.set(`${name}@${version}`, {
      name,
      version,
      license: metadata.license ?? override?.license ?? 'UNKNOWN',
      licenseEvidence: override?.evidence ?? null,
      resolved: metadata.resolved ?? null,
      integrity: metadata.integrity ?? null,
      lockfilePath: key
    })
    if (!metadata.license && !override?.license) unresolved.add(`${name}@${version}`)
  }

  const requiredPeerDependencies = Object.keys(metadata.peerDependencies ?? {})
    .filter(name => metadata.peerDependenciesMeta?.[name]?.optional !== true)
  const dependencyNames = new Set([
    ...Object.keys(metadata.dependencies ?? {}),
    ...Object.keys(metadata.optionalDependencies ?? {}),
    ...requiredPeerDependencies
  ])
  for (const dependencyName of dependencyNames) {
    const dependencyKey = findDependency(resolvedKey, dependencyName)
    if (dependencyKey) queue.push(dependencyKey)
  }
}

const report = {
  reportVersion: 1,
  source: 'Pinned Hermes Agent apps/desktop dependency closure for target platform',
  rendererCommit: process.env.HERMES_SHA ?? null,
  targetPlatform: `${targetOS}-${targetCPU}`,
  lockfileVersion: lock.lockfileVersion,
  packageCount: thirdParty.size,
  unknownLicenseCount: unresolved.size,
  unknownLicenses: [...unresolved].sort(),
  licenseTextCount: licenseTexts.size,
  packagesWithLicenseText: [...licenseTexts.values()].reduce((count, entry) => count + entry.packages.length, 0),
  packagesMissingLicenseText: [...missingLicenseTexts].sort(),
  packages: [...thirdParty.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
const licenseTextDocument = [...licenseTexts.values()]
  .sort((a, b) => a.packages[0].name.localeCompare(b.packages[0].name))
  .map(entry => `## ${entry.packages.map(item => item.name).join(', ')}\n\n${entry.text}`)
  .join('\n\n---\n\n')
writeFileSync(textOutputPath, `${licenseTextDocument}\n`)
console.log(`License inventory: ${report.packageCount} packages; ${report.unknownLicenseCount} unknown licenses; ${report.packagesMissingLicenseText.length} missing license text; ${outputPath}`)
