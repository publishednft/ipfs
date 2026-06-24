// Self-contained IPFS reference table for GitHub Pages.
//
// No backend: reads the on-chain PSIMRegistry directly from the Flow REST API
// (in the browser), then merges it with the bundled catalog + editorial JSON —
// mirroring app/api/psim/verify/route.ts so the static page matches the app.

const PLATFORM = '0x4c55dc21a9da7476'
const ACCESS_NODE = 'https://rest-testnet.onflow.org'

// Gateway selection (see config.js). If a branded Pinata dedicated gateway +
// token is configured, use it (token required, else Pinata returns 401
// ERR_ID:00024). Otherwise fall back to public gateways — Pinata-pinned CIDs
// resolve on any public gateway, and there's no token to expose publicly.
const _cfg = (typeof window !== 'undefined' && window.__IPFS_GATEWAY) || {}
const _tokenQS = _cfg.token ? `?pinataGatewayToken=${_cfg.token}` : ''
// Use the branded Pinata gateway whenever a domain is configured (token is
// appended only if provided). With a token-required gateway you must supply the
// token; if you make the gateway token-optional in Pinata, domain alone works.
// No domain → public gateways.
const GW = _cfg.domain
  ? (cidPath) => `https://${_cfg.domain}/ipfs/${cidPath}${_tokenQS}`
  : (cidPath) => `https://ipfs.io/ipfs/${cidPath}`
// Fallback for cover <img> only — a public gateway so a flaky branded request
// still resolves the image.
const GW_FALLBACK = (cidPath) => `https://dweb.link/ipfs/${cidPath}`
// Cover thumbnails always render from a public gateway (with a second as the
// onerror fallback), independent of the branded gateway, so images never break.
const IMG_GW = (cidPath) => `https://ipfs.io/ipfs/${cidPath}`

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
  // UTF-8-safe base64 decode (atob alone mangles multi-byte chars in titles).
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const json = new TextDecoder().decode(bytes)
  return decode(JSON.parse(json))
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
  const url = GW(cid)
  return `<span class="cid">
    <a href="${url}" target="_blank" rel="noopener" title="${cid}">${shortCid(cid)}</a>
    <button class="copy" data-cid="${cid}" title="Copy CID">⧉</button>
    <a href="https://ipfs.io/ipfs/${cid}" target="_blank" rel="noopener" title="ipfs.io">io</a>
    <a href="https://dweb.link/ipfs/${cid}" target="_blank" rel="noopener" title="dweb.link">dw</a>
  </span>`
}

// Display tweaks for the IPFS reference.
const EXCLUDED = new Set(['the jeweled hoard']) // not a real book — hide it
const FORCE_PD = new Set(['the great gatsby', 'pride and prejudice']) // public-domain ebooks

let BOOKS = []

async function load() {
  const [catalog, psimExtra, metaCids, pdSales] = await Promise.all([
    fetch('./catalog.json').then((r) => r.json()),
    fetch('./psim-extra.json').then((r) => r.json()).then(({ _comment, ...rest }) => rest),
    fetch('./metadata-cids.json').then((r) => r.json()),
    fetch('./pd-sales.json').then((r) => r.json()).catch(() => ({})),
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
  const titleToHref = new Map(catalog.map((c) => [norm(c.title), c.href]))
  // Full catalog entry by title — lets on-chain books inherit the catalog's
  // cover / animated-cover CIDs (psim-extra.json only covers a handful).
  const titleToCat = new Map(catalog.map((c) => [norm(c.title), c]))

  const onChain = raw.map((r) => {
    const cat = titleToCat.get(norm(r.title))
    const coverCID = r.coverImageCID || (cat && cat.coverCID) || r.ipfsCID
    const extra = psimExtra[r.psim] || null
    const cats = r.categories || []
    const fbookId = titleToId.get(norm(r.title)) || ''
    return {
      psim: r.psim, tokenId: r.tokenId, title: r.title, author: r.author,
      productType: r.productType, isbn13: r.isbn13 || null,
      series: extra?.series || null,
      rarity: FORCE_PD.has(norm(r.title))
        ? 'Public Domain'
        : extra?.rarity || (cats.includes('Public Domain') ? 'Public Domain' : cats.includes('Classic') ? 'Classic' : null),
      animatedCoverCID: (extra && extra.animatedCoverCID) || (cat && cat.animatedCoverCID) || null,
      contentCID: r.ipfsCID, coverCID,
      totalSupply: r.totalSupply, mintedCount: r.mintedCount,
      onChain: true,
      fbookId,
      href: titleToHref.get(norm(r.title)) || (fbookId ? `/description/${fbookId}` : ''),
      flowscanUrl: `https://testnet.flowscan.io/account/${PLATFORM}`,
    }
  })

  const onChainTitles = new Set(onChain.map((b) => norm(b.title)))
  const offChain = catalog
    .filter((c) => !onChainTitles.has(norm(c.title)))
    .map((c) => ({
      psim: '', tokenId: '', title: c.title, author: c.author, productType: c.type,
      isbn13: null, series: c.series || null,
      rarity: FORCE_PD.has(norm(c.title)) ? 'Public Domain' : c.rarity || null,
      animatedCoverCID: c.animatedCoverCID || null,
      contentCID: c.contentCID || '', coverCID: c.coverCID || '',
      totalSupply: '', mintedCount: '', onChain: false, fbookId: c.id,
      href: c.href || `/description/${c.id}`, flowscanUrl: '',
    }))

  // Hide non-book entries, then assign sequential eBook numbers and set the
  // public-domain supply to 10% of estimated worldwide sales.
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

  BOOKS = merged
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

  document.getElementById('rows').innerHTML = rows.map((b, i) => {
    // Whole row links to this site's static detail page (stays on github.io):
    // on-chain → ?id=<psim>, off-chain → ?id=<catalog-id>.
    const ipfsId = b.psim || b.fbookId
    const bookUrl = ipfsId ? `./detail.html?id=${encodeURIComponent(ipfsId)}` : null
    const imgHtml = b.coverCID
      ? (() => {
          // Branded Pinata gateway first (serves pinned content reliably), then public gateways.
          const srcs = [`https://ipfs.io/ipfs/${b.coverCID}`, GW(b.coverCID), `https://dweb.link/ipfs/${b.coverCID}`, `https://gateway.lighthouse.storage/ipfs/${b.coverCID}`]
          return `<img loading="lazy" src="${srcs[0]}" data-srcs="${srcs.join('|')}" data-i="0" onerror="var s=this.dataset.srcs.split('|'),i=+this.dataset.i+1;if(s[i]){this.dataset.i=i;this.src=s[i];}else{this.style.visibility='hidden';}"/>`
        })()
      : `<img style="visibility:hidden"/>`
    const coverHtml = bookUrl && b.coverCID
      ? `<a href="${bookUrl}" class="book-cover-link">${imgHtml}</a>`
      : imgHtml
    const titleHtml = bookUrl
      ? `<a href="${bookUrl}" class="book-link"><span>${b.title}</span></a>`
      : `<span>${b.title}</span>`

    return `
    <tr class="${i % 2 ? 'alt' : ''}"${bookUrl ? ` data-url="${bookUrl}" style="cursor:pointer"` : ''}>
      <td class="title" data-label="Book">${coverHtml}${titleHtml}</td>
      <td class="nowrap" data-label="Author">${b.author || ''}</td>
      <td data-label="ISBN-13">${b.isbn13 ? `<code class="isbn">${b.isbn13}</code>` : '<span class="muted">—</span>'}</td>
      <td class="nowrap small" data-label="Series">${b.series || '<span class="muted">—</span>'}</td>
      <td data-label="Rarity">${rarityBadge(b.rarity)}</td>
      <td data-label="PSIM">${b.psim ? `<code class="psim">${b.psim}</code>` : '<span class="muted">—</span>'}</td>
      <td data-label="Flow ID">${b.tokenId ? `<code class="flowid">${b.tokenId}</code>` : '<span class="muted">—</span>'}</td>
      <td data-label="eBook ID">${b.ebookNumber ? `<code class="fbook">${b.ebookNumber}</code>` : '<span class="muted">—</span>'}</td>
      <td data-label="Type"><span class="type">${b.productType}</span></td>
      <td data-label="Mints">${b.mintedCount !== '' ? b.mintedCount + (b.totalSupply && b.totalSupply !== '0' ? ' / ' + b.totalSupply : '') : '<span class="muted">—</span>'}</td>
      <td data-label="IPFS Cover">${cidCell(b.coverCID)}</td>
      <td data-label="IPFS Content">${cidCell(b.contentCID)}</td>
      <td data-label="Animated">${cidCell(b.animatedCoverCID)}</td>
      <td data-label="On-chain">${b.onChain ? `<a class="fs" href="${b.flowscanUrl}" target="_blank" rel="noopener">FlowScan ↗</a>` : '<span class="muted small">Off-chain</span>'}</td>
    </tr>`
  }).join('')
}

document.addEventListener('click', (e) => {
  // Copy-CID button
  const btn = e.target.closest('.copy')
  if (btn) {
    navigator.clipboard.writeText(btn.dataset.cid)
    const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => (btn.textContent = t), 1000)
    return
  }
  // Inner links (CID gateways, FlowScan, title/cover) handle themselves.
  if (e.target.closest('a')) return
  // Otherwise a click anywhere on the row opens its IPFS detail page (same tab).
  const tr = e.target.closest('tr[data-url]')
  if (tr) window.location.href = tr.dataset.url
})
document.getElementById('search').addEventListener('input', render)
document.getElementById('type').addEventListener('change', render)

load()
