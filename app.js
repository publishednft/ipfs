// Self-contained IPFS reference table for GitHub Pages.
//
// No backend: reads the on-chain PSIMRegistry directly from the Flow REST API
// (in the browser), then merges it with the bundled catalog + editorial JSON —
// mirroring app/api/psim/verify/route.ts so the static page matches the app.

const PLATFORM = '0x4c55dc21a9da7476'
const ACCESS_NODE = 'https://rest-testnet.onflow.org'
const GW = 'https://ipfs.publishednft.io/ipfs/'

const SCRIPT = `
import PSIMRegistry from 0x4c55dc21a9da7476

access(all) fun main(contractAddress: String): [PSIMRegistry.PSIMData] {
    let psims = PSIMRegistry.getPSIMsByContract(contractAddress: contractAddress)
    let results: [PSIMRegistry.PSIMData] = []
    for psim in psims {
        if let data = PSIMRegistry.getPSIMData(psim: psim) {
            results.append(data)
        }
    }
    return results
}
`

// ── JSON-Cadence decoder (covers the types PSIMData uses) ───────────────────
function decode(v) {
  if (v == null) return null
  switch (v.type) {
    case 'Optional':
      return v.value ? decode(v.value) : null
    case 'Array':
      return v.value.map(decode)
    case 'Dictionary':
      return Object.fromEntries(v.value.map((kv) => [decode(kv.key), decode(kv.value)]))
    case 'Struct':
    case 'Resource':
    case 'Event': {
      const o = {}
      for (const f of v.value.fields) o[f.name] = decode(f.value)
      return o
    }
    case 'Bool':
      return v.value
    default:
      // Int/UInt*/Fix*/UFix64/String/Address/etc. arrive as strings.
      return v.value
  }
}

async function runRegistryScript() {
  const body = {
    script: btoa(SCRIPT),
    arguments: [btoa(JSON.stringify({ type: 'String', value: PLATFORM }))],
  }
  const res = await fetch(`${ACCESS_NODE}/v1/scripts?block_height=sealed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Flow API ${res.status}: ${await res.text()}`)
  const txt = await res.text()
  const b64 = txt.startsWith('"') ? JSON.parse(txt) : txt
  return decode(JSON.parse(atob(b64)))
}

const norm = (s) => String(s || '').trim().toLowerCase()
const RARITY_COLORS = {
  Legendary: '#fbbf24', Subscription: '#fbbf24', 'Ultra Rare': '#e879f9',
  Limited: '#a5b4fc', Classic: '#22d3ee', Sacred: '#34d399', 'Public Domain': '#2dd4bf',
}

function shortCid(cid) {
  if (!cid) return ''
  return cid.length > 14 ? '…' + cid.slice(-10) : cid
}

function cidCell(cid) {
  if (!cid) return '<span class="muted">—</span>'
  const url = GW + cid
  return `<span class="cid">
    <a href="${url}" target="_blank" rel="noopener" title="${cid}">${shortCid(cid)}</a>
    <button class="copy" data-cid="${cid}" title="Copy CID">⧉</button>
    <a href="https://ipfs.io/ipfs/${cid}" target="_blank" rel="noopener" title="ipfs.io">io</a>
    <a href="https://dweb.link/ipfs/${cid}" target="_blank" rel="noopener" title="dweb.link">dw</a>
  </span>`
}

let BOOKS = []

async function load() {
  const [catalog, psimExtra, metaCids] = await Promise.all([
    fetch('./catalog.json').then((r) => r.json()),
    fetch('./psim-extra.json').then((r) => r.json()).then(({ _comment, ...rest }) => rest),
    fetch('./metadata-cids.json').then((r) => r.json()),
  ])

  let raw = []
  try {
    raw = (await runRegistryScript()) || []
  } catch (e) {
    document.getElementById('warn').textContent =
      'Could not read the on-chain registry (' + e.message + '). Showing off-chain catalog only.'
    document.getElementById('warn').style.display = 'block'
  }

  const titleToId = new Map(catalog.map((c) => [norm(c.title), String(c.id)]))

  const onChain = raw.map((r) => {
    const coverCID = r.coverImageCID || r.ipfsCID
    const extra = psimExtra[r.psim] || null
    const cats = r.categories || []
    return {
      psim: r.psim, tokenId: r.tokenId, title: r.title, author: r.author,
      productType: r.productType, isbn13: r.isbn13 || null,
      series: extra?.series || null,
      rarity: extra?.rarity || (cats.includes('Public Domain') ? 'Public Domain' : cats.includes('Classic') ? 'Classic' : null),
      animatedCoverCID: extra?.animatedCoverCID || null,
      contentCID: r.ipfsCID, coverCID,
      totalSupply: r.totalSupply, mintedCount: r.mintedCount,
      onChain: true,
      fbookId: titleToId.get(norm(r.title)) || '',
      flowscanUrl: `https://testnet.flowscan.io/account/${PLATFORM}`,
    }
  })

  const onChainTitles = new Set(onChain.map((b) => norm(b.title)))
  const offChain = catalog
    .filter((c) => !onChainTitles.has(norm(c.title)))
    .map((c) => ({
      psim: '', tokenId: '', title: c.title, author: c.author, productType: c.type,
      isbn13: null, series: c.series || null, rarity: c.rarity || null,
      animatedCoverCID: c.animatedCoverCID || null,
      contentCID: c.contentCID || '', coverCID: c.coverCID || '',
      totalSupply: '', mintedCount: '', onChain: false, fbookId: c.id, flowscanUrl: '',
    }))

  BOOKS = [...onChain, ...offChain]
  buildTypeFilter()
  render()
  document.getElementById('loading').style.display = 'none'
}

function buildTypeFilter() {
  const types = [...new Set(BOOKS.map((b) => b.productType))].sort()
  const sel = document.getElementById('type')
  for (const t of types) {
    const o = document.createElement('option')
    o.value = t; o.textContent = t; sel.appendChild(o)
  }
}

function render() {
  const q = norm(document.getElementById('search').value)
  const tf = document.getElementById('type').value
  const rows = BOOKS.filter((b) => {
    if (tf !== 'all' && b.productType !== tf) return false
    if (!q) return true
    return [b.title, b.author, b.psim, b.isbn13].some((x) => norm(x).includes(q))
  })

  document.getElementById('count').innerHTML = `<b>${rows.length}</b> of ${BOOKS.length} books`

  const rarityBadge = (r) =>
    r ? `<span class="rarity" style="color:${RARITY_COLORS[r] || '#cbd5e1'};border-color:${(RARITY_COLORS[r] || '#cbd5e1')}55">✦ ${r === 'Public Domain' ? 'Public' : r}</span>` : '<span class="muted">—</span>'

  document.getElementById('rows').innerHTML = rows.map((b, i) => `
    <tr class="${i % 2 ? 'alt' : ''}">
      <td class="title"><img loading="lazy" src="${b.coverCID ? GW + b.coverCID : ''}" onerror="this.style.visibility='hidden'"/><span>${b.title}</span></td>
      <td class="nowrap">${b.author || ''}</td>
      <td>${b.isbn13 ? `<code class="isbn">${b.isbn13}</code>` : '<span class="muted">—</span>'}</td>
      <td class="nowrap small">${b.series || '<span class="muted">—</span>'}</td>
      <td>${rarityBadge(b.rarity)}</td>
      <td>${b.psim ? `<code class="psim">${b.psim}</code>` : '<span class="muted">—</span>'}</td>
      <td>${b.tokenId ? `<code class="flowid">${b.tokenId}</code>` : '<span class="muted">—</span>'}</td>
      <td>${b.fbookId ? `<code class="fbook">${b.fbookId}</code>` : '<span class="muted">—</span>'}</td>
      <td><span class="type">${b.productType}</span></td>
      <td>${b.mintedCount !== '' ? b.mintedCount + (b.totalSupply && b.totalSupply !== '0' ? ' / ' + b.totalSupply : '') : '<span class="muted">—</span>'}</td>
      <td>${cidCell(b.coverCID)}</td>
      <td>${cidCell(b.contentCID)}</td>
      <td>${cidCell(b.animatedCoverCID)}</td>
      <td>${b.onChain ? `<a class="fs" href="${b.flowscanUrl}" target="_blank" rel="noopener">FlowScan ↗</a>` : '<span class="muted small">Off-chain</span>'}</td>
    </tr>`).join('')
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy')
  if (btn) {
    navigator.clipboard.writeText(btn.dataset.cid)
    const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => (btn.textContent = t), 1000)
  }
})
document.getElementById('search').addEventListener('input', render)
document.getElementById('type').addEventListener('change', render)

load()
