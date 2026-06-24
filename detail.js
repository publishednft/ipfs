// Static per-book detail page for GitHub Pages — reads ?id=<psim|catalog-id>,
// builds the same merged book list as the listing (so eBook numbers, public-
// domain supply, and rarity overrides match), and renders the book with its
// animated cover + a floating QR fingerprint badge. No backend.

const PLATFORM = '0x4c55dc21a9da7476'
const ACCESS_NODE = 'https://rest-testnet.onflow.org'

const _cfg = (typeof window !== 'undefined' && window.__IPFS_GATEWAY) || {}
const _tokenQS = _cfg.token ? `?pinataGatewayToken=${_cfg.token}` : ''
const GW = _cfg.domain
  ? (c) => `https://${_cfg.domain}/ipfs/${c}${_tokenQS}`
  : (c) => `https://ipfs.io/ipfs/${c}`
const GW_FALLBACK = (c) => `https://dweb.link/ipfs/${c}`
const IMG_GW = (c) => `https://ipfs.io/ipfs/${c}`

const EXCLUDED = new Set(['the jeweled hoard'])
const FORCE_PD = new Set(['the great gatsby', 'pride and prejudice'])

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

function decode(v) {
  if (v == null) return null
  switch (v.type) {
    case 'Optional': return v.value ? decode(v.value) : null
    case 'Array': return v.value.map(decode)
    case 'Dictionary': return Object.fromEntries(v.value.map((kv) => [decode(kv.key), decode(kv.value)]))
    case 'Struct': case 'Resource': case 'Event': {
      const o = {}; for (const f of v.value.fields) o[f.name] = decode(f.value); return o
    }
    case 'Bool': return v.value
    default: return v.value
  }
}

async function runRegistryScript() {
  const body = { script: btoa(SCRIPT), arguments: [btoa(JSON.stringify({ type: 'String', value: PLATFORM }))] }
  const res = await fetch(`${ACCESS_NODE}/v1/scripts?block_height=sealed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Flow API ${res.status}`)
  const txt = await res.text()
  const b64 = txt.startsWith('"') ? JSON.parse(txt) : txt
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return decode(JSON.parse(new TextDecoder().decode(bytes)))
}

const norm = (s) => String(s || '').trim().toLowerCase()
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const RARITY_COLORS = {
  Legendary: '#fbbf24', Subscription: '#fbbf24', 'Ultra Rare': '#e879f9',
  Limited: '#a5b4fc', Classic: '#22d3ee', Sacred: '#34d399', 'Public Domain': '#2dd4bf',
}

// Build the same merged + numbered list the listing uses.
async function buildBooks() {
  const [catalog, psimExtra, metaCids, pdSales] = await Promise.all([
    fetch('./catalog.json').then((r) => r.json()),
    fetch('./psim-extra.json').then((r) => r.json()).then(({ _comment, ...rest }) => rest),
    fetch('./metadata-cids.json').then((r) => r.json()).catch(() => ({})),
    fetch('./pd-sales.json').then((r) => r.json()).catch(() => ({})),
  ])
  let raw = []
  try { raw = (await runRegistryScript()) || [] } catch { /* off-chain still works */ }

  const titleToId = new Map(catalog.map((c) => [norm(c.title), String(c.id)]))
  const titleToCat = new Map(catalog.map((c) => [norm(c.title), c]))

  const onChain = raw.map((r) => {
    const cat = titleToCat.get(norm(r.title))
    const extra = psimExtra[r.psim] || null
    const cats = r.categories || []
    return {
      psim: r.psim, tokenId: r.tokenId, title: r.title, author: r.author, productType: r.productType,
      isbn13: r.isbn13 || null,
      series: extra?.series || null,
      rarity: FORCE_PD.has(norm(r.title)) ? 'Public Domain' : (extra?.rarity || (cats.includes('Public Domain') ? 'Public Domain' : cats.includes('Classic') ? 'Classic' : null)),
      animatedCoverCID: (extra && extra.animatedCoverCID) || (cat && cat.animatedCoverCID) || null,
      coverCID: r.coverImageCID || (cat && cat.coverCID) || r.ipfsCID, contentCID: r.ipfsCID,
      coverPath: (cat && cat.coverPath) || null,
      metadataCID: metaCids[r.psim] || null,
      totalSupply: r.totalSupply, mintedCount: r.mintedCount, onChain: true,
      fbookId: titleToId.get(norm(r.title)) || '',
    }
  })
  const onChainTitles = new Set(onChain.map((b) => norm(b.title)))
  const offChain = catalog.filter((c) => !onChainTitles.has(norm(c.title))).map((c) => ({
    psim: '', tokenId: '', title: c.title, author: c.author, productType: c.type, isbn13: null,
    series: c.series || null, rarity: FORCE_PD.has(norm(c.title)) ? 'Public Domain' : (c.rarity || null),
    animatedCoverCID: c.animatedCoverCID || null, coverCID: c.coverCID || '', contentCID: c.contentCID || '',
    coverPath: c.coverPath || null,
    metadataCID: null, totalSupply: '', mintedCount: '', onChain: false, fbookId: c.id,
  }))

  const merged = [...onChain, ...offChain].filter((b) => !EXCLUDED.has(norm(b.title)))
  const pdDefault = pdSales._default || 1000000
  merged.forEach((b, i) => {
    b.ebookNumber = i + 1
    if (b.rarity === 'Public Domain') {
      const sales = pdSales[b.fbookId] != null ? pdSales[b.fbookId]
        : pdSales[norm(b.title)] != null ? pdSales[norm(b.title)] : pdDefault
      b.totalSupply = String(Math.round(sales * 0.1))
      if (b.mintedCount === '' || b.mintedCount == null) b.mintedCount = '0'
    }
  })
  return merged
}

// Floating QR fingerprint badge (Data Matrix of the PSIM + rotating ring).
function buildBadge(b, size) {
  const code = b.psim || (b.tokenId ? `${PLATFORM}-${b.tokenId}` : b.fbookId)
  let matrix = ''
  try {
    if (window.bwipjs && code) {
      const svg = window.bwipjs.toSVG({ bcid: 'datamatrix', text: code, barcolor: '111111', scale: 4 })
      matrix = `<img alt="" src="data:image/svg+xml;base64,${btoa(svg)}"/>`
    }
  } catch { /* no matrix */ }
  const label = b.tokenId ? `FLOW ${b.tokenId} · #${b.ebookNumber || b.fbookId}` : `#${b.ebookNumber || b.fbookId}`
  const unit = `${label}  ·  `
  const ring = unit.repeat(Math.max(2, Math.ceil(64 / unit.length) + 1))
  const uid = 'fp' + Math.random().toString(36).slice(2, 8)
  return `<div class="fp-badge" style="width:${size}px;height:${size}px" title="${esc(code)}">
    <div class="fp-disc"></div>
    <svg class="fp-ring" viewBox="0 0 100 100">
      <defs><path id="${uid}" fill="none" d="M50,50 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0"/></defs>
      <text fill="#e5e7eb" font-size="6" letter-spacing="0.4" style="font-family:ui-monospace,monospace;font-weight:600">
        <textPath href="#${uid}">${esc(ring)}</textPath>
      </text>
    </svg>
    <div class="fp-matrix">${matrix}</div>
  </div>`
}

function assetRow(label, cid) {
  if (!cid) return ''
  return `<div class="asset">
    <div class="label">${label}</div>
    <div class="cid"><a href="${GW(cid)}" target="_blank" rel="noopener" title="${esc(cid)}">${esc(cid)}</a></div>
    <div class="gw">
      <button class="copy" data-cid="${esc(cid)}" title="Copy CID">⧉</button>
      <a href="https://ipfs.io/ipfs/${esc(cid)}" target="_blank" rel="noopener">ipfs.io</a>
      <a href="https://dweb.link/ipfs/${esc(cid)}" target="_blank" rel="noopener">dweb</a>
    </div>
  </div>`
}

const field = (k, v) => `<div class="field"><div class="k">${k}</div><div class="v">${v}</div></div>`

function render(b) {
  document.title = `${b.title} — Published NFT IPFS`
  // Passes are landscape cards, not portrait book covers.
  const isPass = /pass/i.test(b.title) || /pass/i.test(b.productType || '') || b.fbookId === 'librarypass'
  const rarityStyle = b.rarity ? `style="color:${RARITY_COLORS[b.rarity] || '#cbd5e1'};border-color:${(RARITY_COLORS[b.rarity] || '#cbd5e1')}66"` : ''
  const staticImg = b.coverCID
    ? `<img class="cover-static" src="${IMG_GW(b.coverCID)}" data-fb="${GW_FALLBACK(b.coverCID)}" alt="${esc(b.title)}" onerror="if(this.src!==this.dataset.fb){this.src=this.dataset.fb;}else{this.style.display='none';}"/>`
    : (b.coverPath ? `<img class="cover-static" src="${esc(b.coverPath)}" alt="${esc(b.title)}" onerror="this.style.display='none'"/>` : '')
  const animated = (b.animatedCoverCID || b.animatedCoverPath)
    ? `<video class="cover-video" autoplay loop muted playsinline ${b.coverCID ? `poster="${IMG_GW(b.coverCID)}"` : (b.coverPath ? `poster="${esc(b.coverPath)}"` : '')}>
         ${b.animatedCoverCID ? `
         <source src="${GW(b.animatedCoverCID)}" type="video/mp4"/>
         <source src="${GW_FALLBACK(b.animatedCoverCID)}" type="video/mp4"/>
         ` : `
         <source src="${esc(b.animatedCoverPath)}" type="video/mp4"/>
         `}
       </video>`
    : ''

  document.getElementById('detail').innerHTML = `
    <div class="hero${isPass ? ' pass' : ''}">
      <div class="cover${isPass ? ' pass' : ''}">
        ${staticImg}
        ${animated}
        ${buildBadge(b, 92)}
      </div>
      <div>
        <div class="author">${esc(b.author) || '—'}</div>
        <h1>${esc(b.title)}</h1>
        <div class="badges">
          <span class="badge type">${esc(b.productType)}</span>
          ${b.rarity ? `<span class="badge rarity" ${rarityStyle}>✦ ${b.rarity === 'Public Domain' ? 'Public Domain' : esc(b.rarity)}</span>` : ''}
          ${b.series ? `<span class="badge rarity">${esc(b.series)}</span>` : ''}
        </div>
        <div class="fields">
          ${field('PSIM', b.psim ? `<code class="psim">${esc(b.psim)}</code>` : '<span class="muted">—</span>')}
          ${field('Flow Token ID', b.tokenId ? `<code class="flowid">${esc(b.tokenId)}</code>` : '<span class="muted">—</span>')}
          ${field('eBook ID', b.ebookNumber ? `<code class="ebook">${b.ebookNumber}</code>` : '<span class="muted">—</span>')}
          ${field('ISBN-13', b.isbn13 ? `<code class="isbn">${esc(b.isbn13)}</code>` : '<span class="muted">—</span>')}
          ${field('Mints', b.mintedCount !== '' && b.mintedCount != null ? esc(b.mintedCount + (b.totalSupply && b.totalSupply !== '0' ? ' / ' + Number(b.totalSupply).toLocaleString() : '')) : '<span class="muted">—</span>')}
          ${field('On-chain', b.onChain ? `<a href="https://testnet.flowscan.io/account/${PLATFORM}" target="_blank" rel="noopener">FlowScan ↗</a>` : '<span class="muted">Off-chain catalog</span>')}
        </div>
      </div>
    </div>

    <h2>IPFS Assets</h2>
    <div class="assets">
      ${assetRow('Cover', b.coverCID)}
      ${assetRow('Content', b.contentCID)}
      ${assetRow('Animated Cover', b.animatedCoverCID)}
      ${assetRow('Metadata JSON', b.metadataCID)}
      ${!b.coverCID && !b.contentCID && !b.animatedCoverCID && !b.metadataCID ? '<div class="asset"><span class="muted">No IPFS assets recorded.</span></div>' : ''}
    </div>

    <div class="banner">Content-addressed on IPFS, linked on-chain by PSIM. Retrieve and authenticate every file through any gateway — <b>verify it yourself</b>.</div>
  `
}

async function load() {
  const id = new URLSearchParams(location.search).get('id') || ''
  if (!id) { fail('No book id in the URL.'); return }
  const books = await buildBooks()
  const b = books.find((x) => x.psim === id) || books.find((x) => String(x.fbookId) === id)
  if (!b) { fail(`No book found for "${esc(id)}".`); return }
  render(b)
}

function fail(msg) {
  const el = document.getElementById('detail')
  el.className = 'err'
  el.textContent = msg
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy')
  if (btn) {
    navigator.clipboard.writeText(btn.dataset.cid)
    const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => (btn.textContent = t), 1000)
  }
})

load().catch((e) => fail(e.message || 'Failed to load.'))
