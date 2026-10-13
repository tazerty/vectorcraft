#!/usr/bin/env python3
"""Portes de la CI web Evora du fork tazerty/vectorcraft (écrit par Evora, EVORA-SIN-04, CI).

Sous-commandes (chacune écrit du Markdown sur la sortie standard, pour le résumé du job, et sort
avec le code 1 quand la porte échoue ou quand son instrument ne voit pas son témoin sabordé) :

  brand <site>                 marques ArtCraft dans le bundle (hors LICENSES/), bloquante
  hosting <site>               fichiers d'hébergement, cachés et liens symboliques, bloquante
  emoji <repo> [--blocking]    émojis et pictogrammes dans les catalogues affichés (patch E10)
  terms <repo>                 termes sensibles dans les catalogues affichés (patch E9), bloquante
  csp <index.html> <sortie>    empreintes sha256 des scripts et styles inline (CSP)
  precompress <site>           .br et .gz à côté des fichiers compressibles, vérifiés par relecture

Lancer avec `python3 -I`. Aucune dépendance hors de la bibliothèque standard ; `brotli` et `gzip`
sont les binaires du runner (leur version est imprimée).
"""

import base64
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

# Ce qui n'est pas « le bundle » : les avis de licence (LICENSE-MIT nomme l'ArtCraft Team, à
# conserver), la fiche de build et les sorties compressées (dérivées des fichiers mesurés).
EXCLUDED_DIRS = ("LICENSES",)
EXCLUDED_FILES = ("EVORA-BUILD.txt", "csp-hashes.txt")
DERIVED_EXT = (".br", ".gz")


def bundle_files(site):
    for dirpath, dirnames, filenames in os.walk(site):
        rel_dir = os.path.relpath(dirpath, site)
        if rel_dir.split(os.sep)[0] in EXCLUDED_DIRS:
            continue
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, site)
            if name in EXCLUDED_FILES or name.endswith(DERIVED_EXT) or os.path.islink(path):
                continue
            yield rel, path


# (libellé, motif, insensible à la casse, bloquant)
BRAND_PATTERNS = [
    ("`ArtCraft` (casse exacte)", b"ArtCraft", False, True),
    ("`artcraft` (toute casse)", b"artcraft", True, True),
    ("`getartcraft` (toute casse)", b"getartcraft", True, True),
    ("`discord.gg` (toute casse)", b"discord.gg", True, True),
    ("`discord` (toute casse, information)", b"discord", True, False),
    ("`VectorCraft` (casse exacte, information)", b"VectorCraft", False, False),
]


def brand_counts(site):
    totals = [0] * len(BRAND_PATTERNS)
    per_file = []
    for rel, path in bundle_files(site):
        with open(path, "rb") as fh:
            data = fh.read()
        lower = data.lower()
        counts = [(lower if ci else data).count(pat.lower() if ci else pat) for _, pat, ci, _ in BRAND_PATTERNS]
        for i, n in enumerate(counts):
            totals[i] += n
        if any(n for n, (_, _, _, blocking) in zip(counts, BRAND_PATTERNS) if blocking):
            per_file.append((rel, counts))
    return totals, per_file


def brand_witness():
    """Un témoin construit hors de l'artefact : l'instrument doit y voir 1 / 2 / 1 / 1."""
    root = tempfile.mkdtemp(prefix="evora-temoin-marques-")
    try:
        os.makedirs(os.path.join(root, "LICENSES"))
        files = {
            "a.js": b"// Made by ArtCraft\n",
            "b.wasm": b"\x00\x61\x73\x6d https://discord.gg/x \x00 getartcraft.com \xff",
            "LICENSES/LICENSE-MIT": b"Copyright (c) ArtCraft Team",  # exclu : avis de licence
            "c.wasm.br": b"ArtCraft",  # exclu : sortie dérivée
            "EVORA-BUILD.txt": b"ArtCraft",  # exclu : fiche de build
        }
        for rel, data in files.items():
            with open(os.path.join(root, rel), "wb") as fh:
                fh.write(data)
        totals, _ = brand_counts(root)
        return totals[:4]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def cmd_brand(site):
    totals, per_file = brand_counts(site)
    witness = brand_witness()
    print("### Marques ArtCraft dans le bundle (porte bloquante : 0), hors `LICENSES/`")
    print()
    print("| Motif | Occurrences | Bloquant |")
    print("|---|---|---|")
    for (label, _, _, blocking), n in zip(BRAND_PATTERNS, totals):
        print(f"| {label} | {n} | {'oui' if blocking else 'non'} |")
    print()
    if per_file:
        print("Détail par fichier (motifs bloquants) :")
        for rel, counts in per_file:
            print(f"- `{rel}` : " + ", ".join(f"{BRAND_PATTERNS[i][0]} {n}" for i, n in enumerate(counts) if n and BRAND_PATTERNS[i][3]))
        print()
    print(f"- témoin sabordé (attendu 1 / 2 / 1 / 1) : {' / '.join(str(n) for n in witness)}")
    ok_witness = witness == [1, 2, 1, 1]
    blocking_hits = sum(n for (_, _, _, b), n in zip(BRAND_PATTERNS, totals) if b)
    verdict = "VERTE" if ok_witness and blocking_hits == 0 else "ROUGE"
    print(f"- verdict : **{verdict}** (occurrences bloquantes : {blocking_hits} ; témoin {'vu' if ok_witness else 'NON VU'})")
    print()
    return 0 if verdict == "VERTE" else 1


HOSTING_NAMES = ("_headers", ".htaccess")
HOSTING_EXT = (".conf", ".php", ".phtml", ".phar")


def hosting_scan(site):
    hosting, hidden, links = [], [], []
    for dirpath, dirnames, filenames in os.walk(site, followlinks=False):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, site)
            if os.path.islink(path):
                links.append(rel)
            if name.startswith("."):
                hidden.append(rel)
            if name in HOSTING_NAMES or name.lower().endswith(HOSTING_EXT):
                hosting.append(rel)
    return sorted(hosting), sorted(hidden), sorted(links)


def hosting_witness():
    root = tempfile.mkdtemp(prefix="evora-temoin-hebergement-")
    try:
        os.makedirs(os.path.join(root, "sous"))
        for rel in ("_headers", "sous/.htaccess", "site.conf", "x.php"):
            open(os.path.join(root, rel), "w").close()
        os.symlink("site.conf", os.path.join(root, "lien"))
        return [len(x) for x in hosting_scan(root)]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def cmd_hosting(site):
    hosting, hidden, links = hosting_scan(site)
    witness = hosting_witness()
    print("### Fichiers d'hébergement dans l'artefact (porte bloquante : aucun)")
    print()
    print(f"- `_headers`, `.htaccess`, `*.conf`, `*.php` : {', '.join(hosting) or 'aucun'}")
    print(f"- fichiers ou dossiers cachés : {', '.join(hidden) or 'aucun'}")
    print(f"- liens symboliques : {', '.join(links) or 'aucun'}")
    print(f"- témoin sabordé (attendu 4 / 1 / 1) : {' / '.join(str(n) for n in witness)}")
    ok = witness == [4, 1, 1] and not (hosting or hidden or links)
    print(f"- verdict : **{'VERTE' if ok else 'ROUGE'}**")
    print()
    return 0 if ok else 1


def is_pictograph(cp):
    """Émojis et pictogrammes : symboles divers, dingbats, symboles et flèches divers, plans
    émoji, sélecteur de variante émoji, et les caractères à présentation émoji des autres blocs."""
    return (
        0x2600 <= cp <= 0x27BF
        or 0x2B00 <= cp <= 0x2BFF
        or 0x1F000 <= cp <= 0x1FAFF
        or cp == 0xFE0F
        or cp in (0x203C, 0x2049, 0x231A, 0x231B, 0x2328, 0x23CF, 0x25B6, 0x25C0)
        or 0x23E9 <= cp <= 0x23F3
        or 0x23F8 <= cp <= 0x23FA
    )


# Les catalogues affichés : les TSV de `ui-egui` (toutes langues, source anglaise comprise) et les
# sources de l'interface (`ui-egui`, crate web), hors lignes de commentaire.
DISPLAY_ROOTS = ("crates/ui-egui/src", "apps/vectorcraft-web")


def emoji_scan(repo):
    hits = []
    for base in DISPLAY_ROOTS:
        for dirpath, _, filenames in os.walk(os.path.join(repo, base)):
            for name in sorted(filenames):
                if not name.endswith((".rs", ".tsv", ".html")):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as fh:
                    for i, line in enumerate(fh, 1):
                        s = line.lstrip()
                        if (name.endswith(".tsv") and s.startswith("#")) or (name.endswith(".rs") and s.startswith("//")):
                            continue
                        for ch in line:
                            if is_pictograph(ord(ch)):
                                hits.append((os.path.relpath(path, repo), i, ch))
    return hits


def cmd_emoji(repo, blocking):
    hits = emoji_scan(repo)
    root = tempfile.mkdtemp(prefix="evora-temoin-emoji-")
    try:
        os.makedirs(os.path.join(root, "crates/ui-egui/src"))
        with open(os.path.join(root, "crates/ui-egui/src/x.rs"), "w", encoding="utf-8") as fh:
            fh.write('// ⚠ commentaire ignoré\nlet a = "✓ ★";\n')
        with open(os.path.join(root, "crates/ui-egui/src/x.tsv"), "w", encoding="utf-8") as fh:
            fh.write("# ⚠ commentaire ignoré\n\t⚠ {n}\tAttention\n")
        witness = len(emoji_scan(root))
    finally:
        shutil.rmtree(root, ignore_errors=True)
    kind = "bloquante" if blocking else "information, bloquante avec le patch E10"
    print(f"### Émojis et pictogrammes dans les catalogues affichés (porte {kind} : 0)")
    print()
    counts = {}
    for _, _, ch in hits:
        counts[ch] = counts.get(ch, 0) + 1
    print(f"- total : {len(hits)}")
    for ch, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"- U+{ord(ch):04X} {unicodedata.name(ch, '?')} : {n}")
    for rel, line, ch in hits:
        print(f"  - `{rel}:{line}` U+{ord(ch):04X}")
    print(f"- témoin sabordé (attendu 3) : {witness}")
    ok_witness = witness == 3
    green = ok_witness and not hits
    print(f"- verdict : **{'VERTE' if green else 'ROUGE'}**{'' if blocking else ' (non bloquante)'}")
    print()
    if not ok_witness:
        return 1
    return 1 if blocking and hits else 0


# Termes de tiers à ne pas afficher (ARCHITECTURE §3.4, D-16) ; mots entiers, toute casse.
SENSITIVE = ["Lumetri", "Lightroom", "Acrobat", "Premiere", "Adobe", "Cycore", "Premiere Pro Compatible",
             "Illustrator", "Photoshop", "InDesign", "After Effects"]


def terms_scan(repo):
    found = {t: [] for t in SENSITIVE}
    regs = {t: re.compile(r"(?<![\w])" + re.escape(t) + r"(?![\w])", re.IGNORECASE) for t in SENSITIVE}
    cat_dir = os.path.join(repo, "crates/ui-egui/src/i18n")
    for name in sorted(os.listdir(cat_dir)):
        if not name.endswith(".tsv"):
            continue
        with open(os.path.join(cat_dir, name), encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if line.lstrip().startswith("#"):
                    continue
                for t, rx in regs.items():
                    if rx.search(line):
                        found[t].append(f"{name}:{i}")
    return found


def cmd_terms(repo):
    found = terms_scan(repo)
    print("### Termes sensibles dans les catalogues affichés (patch E9, porte bloquante : 0)")
    print()
    print("Catalogues TSV de `ui-egui` (13 langues ; la colonne source porte chaque chaîne anglaise affichée), lignes de commentaire exclues.")
    print()
    print("| Terme | Occurrences |")
    print("|---|---|")
    total = 0
    for t in SENSITIVE:
        print(f"| {t} | {len(found[t])} |")
        total += len(found[t])
    for t in SENSITIVE:
        for where in found[t][:20]:
            print(f"- {t} : `{where}`")
    print(f"- verdict : **{'VERTE' if total == 0 else 'ROUGE'}**")
    print()
    return 0 if total == 0 else 1


SCRIPT_RX = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)
STYLE_RX = re.compile(r"<style\b([^>]*)>(.*?)</style\s*>", re.IGNORECASE | re.DOTALL)
HANDLER_RX = re.compile(r"<[^>]+\son[a-z]+\s*=", re.IGNORECASE)


def sha256_b64(text):
    return base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def cmd_csp(index_html, out):
    with open(index_html, encoding="utf-8") as fh:
        html = fh.read()
    scripts = [(m.group(1), m.group(2)) for m in SCRIPT_RX.finditer(html)]
    inline = [body for attrs, body in scripts if not re.search(r"\bsrc\s*=", attrs, re.IGNORECASE)]
    external = len(scripts) - len(inline)
    styles = [m.group(2) for m in STYLE_RX.finditer(html)]
    handlers = len(HANDLER_RX.findall(html))
    lines = ["# Empreintes CSP des éléments inline de index.html (Evora, CI evora-web.yml)."]
    lines += [f"script-src 'sha256-{sha256_b64(b)}'" for b in inline]
    lines += [f"style-src 'sha256-{sha256_b64(b)}'" for b in styles]
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("### Empreintes CSP (`csp-hashes.txt`)")
    print()
    print(f"- scripts inline : {len(inline)} ; scripts externes : {external} ; styles inline : {len(styles)} ; attributs `on*=` : {handlers}")
    print("```")
    print("\n".join(lines[1:]))
    print("```")
    ok = handlers == 0
    print(f"- verdict : **{'VERTE' if ok else 'ROUGE'}** (aucun gestionnaire d'événement inline exigé)")
    print()
    return 0 if ok else 1


# Déjà compressés ou sans intérêt : on ne les double pas.
NO_COMPRESS = (".woff2", ".woff", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".br", ".gz")
MIN_SIZE = 1024


def cmd_precompress(site):
    rows = []
    for rel, path in list(bundle_files(site)):
        if rel.lower().endswith(NO_COMPRESS) or os.path.getsize(path) < MIN_SIZE:
            continue
        raw = os.path.getsize(path)
        with open(path, "rb") as src, open(path + ".gz", "wb") as dst:
            subprocess.run(["gzip", "-9", "-n", "-c"], stdin=src, stdout=dst, check=True)
        subprocess.run(["brotli", "-q", "11", "-f", "-o", path + ".br", path], check=True)
        # Relecture : chaque sortie se décompresse à l'identique.
        with open(path, "rb") as fh:
            original = fh.read()
        gz = subprocess.run(["gzip", "-dc", path + ".gz"], capture_output=True, check=True).stdout
        br = subprocess.run(["brotli", "-dc", path + ".br"], capture_output=True, check=True).stdout
        if gz != original or br != original:
            print(f"- relecture en échec pour `{rel}`")
            return 1
        rows.append((rel, raw, os.path.getsize(path + ".gz"), os.path.getsize(path + ".br")))
    print("### Taille et sorties précompressées (`.gz` : gzip -9 -n ; `.br` : brotli -q 11), relues à l'identique")
    print()
    print("| Fichier | Brut (octets) | .gz | .br |")
    print("|---|---|---|---|")
    for rel, raw, gz, br in rows:
        print(f"| `{rel}` | {raw} | {gz} | {br} |")
    tot = [sum(r[i] for r in rows) for i in (1, 2, 3)]
    print(f"| **total compressible** | {tot[0]} | {tot[1]} | {tot[2]} |")
    print()
    return 0


def cmd_smoke_summary(path):
    """Met en forme le rapport JSON de smoke.mjs (la porte elle-même est le code de sortie de smoke.mjs)."""
    import json

    print("### Test de fumée : moteur servi sur une origine A, dans l'iframe d'une page servie sur une origine B (porte bloquante)")
    print()
    try:
        with open(path, encoding="utf-8") as fh:
            r = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"- rapport illisible : {e}")
        print()
        return 1
    p = r.get("probe") or {}
    px = r.get("pixels") or {}
    tl = r.get("timeline") or {}
    csp = r.get("cspReportOnly") or {}
    print(f"- verdict : **{'VERTE' if r.get('ok') else 'ROUGE'}**{'' if r.get('ok') else ' : ' + '; '.join(r.get('reasons', []))}")
    print(f"- navigateur : {r.get('chrome')} ; origine A (moteur) : `{r.get('originA')}` ; origine B (parente) : `{r.get('originB')}`")
    print(f"- démarrage à froid, mesuré dans l'iframe (`performance.now()` au retrait du voile) : **{r.get('coldStartMs')} ms** ; depuis la navigation de la page parente : {r.get('parentToReadyMs')} ms")
    print(f"- contexte de l'iframe vu à {tl.get('contextA')} ms ; sondages : {tl.get('polls')}")
    print(f"- canvas : présent={p.get('canvas')} ; {p.get('width')}×{p.get('height')} px (affiché {p.get('clientWidth')}×{p.get('clientHeight')}) ; titre : « {p.get('title')} » ; `navigator.gpu` : {p.get('webgpu')}")
    print(f"- moteur graphique annoncé par le moteur : {r.get('backend') or 'non vu dans la console'}")
    st = r.get("storage") or {}
    if st.get("seeded"):
        print(f"- stockage hébergé (E5) : `?host={st.get('host')}` ; semé avant le moteur : {', '.join('`' + k + '`' for k in st['seeded'])} ; après démarrage : {', '.join('`' + k + '`' for k in (st.get('after') or [])) or 'aucune clé'}")
    lang = r.get("lang") or {}
    if lang.get("requested"):
        print(f"- langue imposée (E3) : `?lang={lang.get('requested')}` ; attribut `lang` attendu « {lang.get('expected')} », obtenu « {lang.get('got')} »")
    print(f"- exceptions de page : {len(r.get('exceptions', []))} ; requêtes en échec sur A : {len(r.get('failedRequestsA', []))} ; hors A : {len(r.get('failedRequestsOther', []))} ; erreurs console : {len(r.get('consoleErrors', []))} ; plantage : {r.get('crashed')}")
    print(f"- requêtes servies par A : {r.get('requestsA')} ({r.get('bytesA')} octets, non compressés)")
    if "distinctColors" in px:
        print(f"- rendu (capture de la zone de l'iframe {px['region']['width']}×{px['region']['height']}) : {px['distinctColors']} couleurs distinctes, {px['nonBackgroundRatio']} des pixels hors du fond #262626 (information)")
    elif px:
        print(f"- rendu : {px}")
    print(f"- CSP de l'origine moteur en Report-Only : {len(csp.get('violations', []))} violation(s) (information)")
    print("```")
    print(csp.get("policy") or "(aucune)")
    print("```")
    for title, key in (("Exceptions", "exceptions"), ("Requêtes en échec sur A", "failedRequestsA"), ("Requêtes en échec hors A", "failedRequestsOther"),
                       ("Erreurs console", "consoleErrors"), ("Violations CSP", None)):
        items = csp.get("violations", []) if key is None else r.get(key, [])
        if items:
            print(f"<details><summary>{title} ({len(items)})</summary>\n")
            print("```")
            for it in items[:40]:
                print(json.dumps(it, ensure_ascii=False)[:400])
            print("```")
            print("</details>\n")
    tail = r.get("consoleTail") or []
    if tail:
        print("<details><summary>Fin de la console</summary>\n")
        print("```")
        print("\n".join(t[:300] for t in tail[-20:]))
        print("```")
        print("</details>\n")
    print()
    return 0


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "smoke-summary":
        return cmd_smoke_summary(argv[2])
    if cmd == "brand":
        return cmd_brand(argv[2])
    if cmd == "hosting":
        return cmd_hosting(argv[2])
    if cmd == "emoji":
        return cmd_emoji(argv[2], "--blocking" in argv[3:])
    if cmd == "terms":
        return cmd_terms(argv[2])
    if cmd == "csp" and len(argv) == 4:
        return cmd_csp(argv[2], argv[3])
    if cmd == "precompress":
        return cmd_precompress(argv[2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
