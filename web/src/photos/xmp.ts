/**
 * A photo's description in its XMP (dc:description, which Photos, Lightroom and Google Photos show
 * as the caption), written when a photo is shared so the description goes with the file.
 */

const DC = 'http://purl.org/dc/elements/1.1/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const block = (text: string) =>
  `<rdf:Description rdf:about="" xmlns:dc="${DC}"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escape(text)}</rdf:li></rdf:Alt></dc:description></rdf:Description>`;

/** The XMP packet with `text` as its description (any description it had replaced; an empty
 *  `text` removes it). With no packet, a new one. */
export function withDescription(xmp: string | null, text: string): string | null {
  const t = text.trim();
  if (xmp && xmp.includes('</rdf:RDF>')) {
    const without = xmp.replace(/<dc:description\b[^>]*\/>|<dc:description\b[^>]*>[\s\S]*?<\/dc:description>/g, '').replace(/\sdc:description="[^"]*"/g, '');
    return t ? without.replace('</rdf:RDF>', `${block(t)}</rdf:RDF>`) : without;
  }
  if (!t) return xmp;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">${block(t)}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/** The description an XMP packet holds (the default language's), if any. */
export function descriptionOf(xmp: string | null): string | null {
  const m = xmp && /<dc:description\b[^>]*>[\s\S]*?<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
  if (!m) return null;
  const s = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
  return s || null;
}
