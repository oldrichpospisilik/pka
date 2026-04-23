---
name: audiobook-ingest
description: Zpracuj syrové audioknihy v /mnt/p/My Audiobooks/__raw/ — rozbalení archivů (7z/zip), sloučení vnořených složek, rozpoznání autora a názvu, přejmenování adresáře na "Jméno Příjmení - Název", doplnění a sjednocení ID3/MP4 tagů (TPE1 autor, TALB název, TIT2 kapitola, TRCK, TCON=Audiokniha), stažení obálky a embed do všech mp3/m4a. Přesun do /mnt/p/My Audiobooks/. Spouští uživatel zprávou jako "roztřiď audioknihy", "zpracuj raw audioknihy", "audiobook ingest", "uklid audioknihy".
---

# audiobook-ingest

Plně automatický skill na sanitizaci audioknih přidaných do `__raw/`. **Neptá se uživatele** — rozhodne se z metadat a kontextu, na konci vypíše souhrn.

## Primární cesty

| Účel | Cesta |
|---|---|
| Vstup (neroztříděné) | `/mnt/p/My Audiobooks/__raw/` *(pozor: DVĚ podtržítka)* |
| Cíl (výchozí) | `/mnt/p/My Audiobooks/` (root) |
| Speciální kategorie | `_Astronomie/`, `_Pohádky/` (jedno podtržítko = nahoře v řazení) |
| Historie změn | `/mnt/p/My Audiobooks/REORGANIZACE.md` (append; vytvoř, pokud neexistuje) |

## Konvence cílové knihovny

Zjištěno z existujících 115 knih:

- **Název složky**: `Jméno Příjmení - Název` (křestní first, bez čárky, s českou diakritikou).
- **Víc autorů**: `Jméno1 Příjmení1, Jméno2 Příjmení2 - Název` (viz `Vojtěch Matocha, Karel Osoha - Prašina`).
- **Série**: zatím **bez číslování v názvu složky** (viz `Bernard Cornwell - Poslední království`, `Bernard Cornwell - Bledý jezdec` — série Saxon Stories, ale čísla chybí). Respektuji to — série si user řídí ručně.
- **Speciální**: knihy o astronomii → `_Astronomie/`, dětské pohádky → `_Pohádky/`. Ostatní přímo do kořene.

### Formáty souborů uvnitř

- **mp3** (dominantní) — `NN.mp3` nebo `NN - Kapitola.mp3` nebo `NN - Kniha X - Název, cast N.mp3`.
- **m4a** (občas — třeba *Tři sekery* od Kateřiny Surmanové). Nekonvertuj na mp3 — ponechej.
- **cover.jpg** v adresáři (pro Finder preview) + embed do tagů (APIC frame).

### ID3/MP4 tagy

| Tag | Co |
|---|---|
| `TIT2` / `©nam` (M4A) | Kapitola — "Prolog", "01", "Kniha prvni - Duna, cast 1" |
| `TPE1` / `©ART` | **Autor** — "Frank Herbert" (Jméno Příjmení) |
| `TALB` / `©alb` | **Název knihy** — "Duna" |
| `TRCK` / `trkn` | Číslo stopy (01, 02, …) |
| `TPOS` / `disk` | Disk u víc-diskových knih (`01/02`) |
| `TDRC` / `©day` | Rok (pokud zjistitelný) |
| `TCON` / `©gen` | Žánr — **vždy "Audiokniha"** |
| `TCOM` / `©wrt` | Autor (redundantně) |
| `COMM` | Interpret / čte — "Čte: Jiří Klika" *(časté místo pro cp1250 garbled — oprav!)* |
| `APIC` / `covr` | Embedded cover |

## Workflow (per položka v `__raw/`)

### 0. Předběžné kontroly

Před startem dávky:

1. **pCloud mount** — pokud `/mnt/p/` není dostupný, `sudo mount /mnt/p`. Pokud selže, řekni uživateli ať spustí pCloud a zkus znovu.
2. **Dependency check**:
   - **Povinné**: `python3` + `mutagen` (`python3 -c 'import mutagen'`).
   - **Nice-to-have**: `7z` (rozbalování archivů — `sudo apt install p7zip-full`), `ffmpeg` (konverze m4a↔mp3 pokud potřeba — `sudo apt install ffmpeg`).
   - Když chybí povinné → řekni uživateli, jak instalovat, a skonči. Když chybí nice-to-have → flagni v reportu, ale pokračuj.
3. **Spočítej položky** v `__raw/` (top-level adresáře + volné soubory) a ohlaš plán.

### 1. Normalizace struktury

Pro každý vstup v `__raw/`:

**a) Archivy** — pokud obsahuje `.7z`, `.zip`, `.rar`:
- Rozbal vedle (`7z x CD1.7z -o./`).
- Smaž archivy po úspěšném rozbalení.
- Pokud `7z` chybí → flagni "potřebuje 7z, přeskočeno" a pokračuj dalším.

**b) Vnořené složky** — pokud `__raw/<book>/` obsahuje jednu podsložku a nic jiného (např. `Gaiman & Pratchett - Dobrá znamení/Gaiman & Pratchett - Dobrá znamení - audiokniha - čte Jan Zadražil/01.mp3`):
- Vytáhni obsah podsložky na úroveň `<book>/`.
- Smaž prázdnou podsložku.
- Opakuj, dokud je nutnost (některé raw mají 2–3 úrovně).

**c) Smetí** — smaž `.m3u`, `.nfo`, `Thumbs.db`, `.DS_Store`, `desktop.ini`, `*.url`.

### 2. Rozpoznání autora a názvu

Priorita zdrojů:

1. **ID3 tagy prvního mp3** (`TPE1` + `TALB`) — pokud vypadají rozumně.
2. **Název adresáře** — parsuj vzorce:
   - `Jméno Příjmení - Název` → OK přímo.
   - `Příjmení Jméno - Název` → **prohoď** (u `Špitálníková Nina - Svědectví…` byla výjimka, ale ve většině případů user chce Jméno Příjmení).
   - `Autor1 & Autor2 - Název` → OK (zachovej `&` nebo převeď na čárku).
   - `Mluvene Slovo <Autor> - <Název> (poznámky)` → odstraň "Mluvene Slovo" prefix a závorkové poznámky.
   - Exotické názvy se závorkovými suffixy (`(11h02m56s)`, `(2021)(CZ)`, `(Maedhros)`) → odstraň všechny suffix závorky.
3. **`fetch-ebook-metadata`** (z Calibre) — pokud název chaotický, zkus:
   ```bash
   fetch-ebook-metadata --title "pravděpodobný název" --authors "pravděpodobný autor" --opf /tmp/meta.opf --cover /tmp/cover.jpg
   ```

### 3. Standardizace názvu adresáře

Finální formát: `Jméno Příjmení - Název`

**Pravidla**:
- Česká diakritika zachovat.
- Filesystem-breaking znaky (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) → nahradit pomlčkou nebo smazat.
- Úvodní/koncové mezery odstranit.
- Víc autorů → oddělit čárkou (`Vojtěch Matocha, Karel Osoha - Prašina`).

### 4. Doplnění a sjednocení tagů

Pro všechny `.mp3` a `.m4a` v adresáři spusť:

```bash
python3 "$SKILL_DIR/scripts/fix-tags.py" \
  --dir "/mnt/p/My Audiobooks/__raw/<book>/" \
  --author "Jméno Příjmení" \
  --album "Název knihy" \
  --genre "Audiokniha" \
  --year "2024" \
  --comment "Čte: Jméno interpreta"  # pokud zjistitelné
```

Skript:
- Doplní chybějící tagy, **přepíše** prázdné/rozbité (TPE1=Unknown, TALB=index).
- Nastaví `TRCK` podle pořadí v abecedním seznamu (pokud kapitoly mají přirozené číslo v názvu, použije ho).
- Opraví rozbité cp1250 tagy (COMM, TIT2) — viz bod 5.
- Neztratí existující `APIC` (obálku), pokud je.

### 5. Oprava cp1250 garbled v tagách

Pokud v některém tagu najdeš `ø, è, ì, ù, ð, ò, ¾, »` (viz ebook REFERENCE):

```bash
python3 "$SKILL_DIR/scripts/fix-comm-cp1250.py" \
  --dir "/mnt/p/My Audiobooks/__raw/<book>/"
```

Přepíše tagy s opravenou diakritikou (`Ète` → `Čte`, `Jiøí` → `Jiří`, `Klika` → `Klika` atd.).

### 6. Obálka

Priority (zkoušej v tomhle pořadí, zastav na první úspěch):

1. **Existující soubor** v raw složce (`cover.jpg`, `cover.png`, `folder.jpg`, `*.jpeg`, `*.webp`, `líc.jpg` — první ze Surmanové) → použij.
   - Pro `.webp` → konvertuj na `.jpg` přes Pillow:
     ```python
     python3 -c "from PIL import Image; Image.open('cover.webp').convert('RGB').save('cover.jpg', 'JPEG', quality=90)"
     ```
2. **APIC v existujících tagách** — pokud první mp3 už má embedded cover a na disku není `cover.jpg`, extrahuj:
   ```bash
   python3 "$SKILL_DIR/scripts/extract-cover.py" "<první.mp3>" "<book>/cover.jpg"
   ```
3. **databazeknih.cz** (nejspolehlivější zdroj pro české knihy — Calibre na ně má slabou detekci):
   ```bash
   python3 "$SKILL_DIR/scripts/fetch-cover-dbknih.py" \
     --title "Název" --author "Autor" --out "<book>/cover.jpg"
   ```
   **Validace**: scraper vrací první výsledek — pro málo známé knihy může vrátit nerelevantní. Porovnej slug v URL (stderr výstup `book page:`) s názvem; pokud hrubě nesedí (např. `o-cem-sni-zeny` pro `O čem skály mlčí`), smaž stažený soubor a pokračuj krokem 4.
4. **`fetch-ebook-metadata`** z Calibre (fallback):
   ```bash
   fetch-ebook-metadata --title "Název" --authors "Autor" --cover "/tmp/cover.jpg"
   ```
   Zkus český i anglický název.
5. **Nic nenalezeno** → pokračuj bez obálky a flagni v reportu "chybí obálka, doplnit ručně".

Po získání `cover.jpg` ho **vlož do všech audio souborů**:

```bash
python3 "$SKILL_DIR/scripts/embed-cover.py" \
  --dir "/mnt/p/My Audiobooks/__raw/<book>/" \
  --cover "/mnt/p/My Audiobooks/__raw/<book>/cover.jpg"
```

### 7. Přejmenování souborů (volitelné)

Default: **nepřejmenovávej audio soubory** — existující názvy (`01.mp3`, `01 - Prolog.mp3`, `NázevKnihy 01.mp3`) jsou všechny přijatelné v knihovně.

Přejmenuj **jen pokud** jsou názvy zjevně rozbité:
- `audio-track-1.mp3`, `track-001.mp3`, `NAHRÁVKA_2024-05-12.mp3` → `01.mp3`, `02.mp3`, … podle pořadí.

Zachovat přirozený sort (0-padding na 2 místa minimálně).

### 8. Zařazení do kategorie

**Automatické rozhodnutí:**

- **`_Astronomie/`** pokud: název obsahuje `astronom`, `vesmír`, `hvězd`, `galax`, `planet`, `Sluneční soustav`, `kosmolog`, nebo autor je Aldebaran / Grygar / NASA.
- **`_Pohádky/`** pokud: název obsahuje `pohád`, `pro děti`, `dětská`, `Václav Čtvrtek`, `Karel Čapek (Devatero pohádek)`, `Krtek`, `Ferda Mravenec`, autor je Zdeněk Miler / Václav Čtvrtek.
- **`/` (root)** — vše ostatní.

Nejistota → root (default), flagni v reportu.

### 9. Přesun do cílového místa

```bash
mv "/mnt/p/My Audiobooks/__raw/<book>" "/mnt/p/My Audiobooks/[_Astronomie/|_Pohádky/]<Jméno Příjmení - Název>"
```

**pCloud retry logika** — občas `mv` selže s `Permission denied` nebo `Directory not empty` kvůli krátkodobému pCloud file locku (sync v běhu). Pokud primární `mv` selže:

```bash
# 1) retry po 2 sekundách
sleep 2 && mv "$SRC" "$DST" 2>/dev/null && exit 0

# 2) cp + rm fallback
cp -r "$SRC" "$DST"
if [ $? -eq 0 ]; then
  for i in 1 2 3 4 5; do
    sleep 2
    rm -rf "$SRC" 2>/dev/null && break
  done
fi

# 3) pokud rm stále neprošel, src zůstane — flagni k ruční kontrole
[ -d "$SRC" ] && echo "WARN: $SRC se nepodařilo smazat — ručně"
```

Kolize s existujícím adresářem:
- Porovnej obsah — pokud identický (stejné soubory, velikosti) → smaž z raw, je to duplicita.
- Pokud jiný → přejmenuj nový na `<původní> (nová verze)` a flagni.

### 10. Zápis do REORGANIZACE.md

Append do `/mnt/p/My Audiobooks/REORGANIZACE.md`. Pokud neexistuje, vytvoř s hlavičkou:

```markdown
# Reorganizace audioknihovny

Historie úprav knihovny přes `audiobook-ingest` skill.

---
```

Pak pro každou dávku:

```markdown
## YYYY-MM-DD: Ingest z __raw (N knih)

| Raw | Autor | Název | Kategorie | Změny |
|-----|-------|-------|-----------|-------|
| `Mluvene Slovo Gaiman Neil - Nikdykde (...)` | Neil Gaiman | Nikdykde | root | rozbalen 7z, tagy doplněny, obálka z Calibre |
| `Kateřina Surmanová - Tři sekery` | Kateřina Surmanová | Tři sekery | root | jen tagy + cover embed (struktura OK) |

**Problémy** (flagged):
- `<book>` — chybí obálka, doplnit ručně.
- `<book>` — autor nejasný, zůstává v `__raw/_unsorted/`.
```

Pokud `_unsorted/` neexistuje, vytvoř ho.

## Report na konci dávky

```
Zpracováno: X položek z __raw/
├── root: N knih (seznam)
├── _Astronomie: M (seznam)
├── _Pohádky: K (seznam)
└── __raw/_unsorted: L (seznam + důvod)

Opravy:
- Rozbalené archivy: N
- Vyplochované vnořené struktury: M
- cp1250 fix v tagách: P knih
- Nově stažené obálky: Q
- Obálky embedded: R souborů

Dependency status:
- mutagen: OK
- 7z: OK / chybí
- ffmpeg: OK / chybí

REORGANIZACE.md: aktualizováno
```

## Bezpečnostní pravidla

- **Nikdy nemaž** z kořene `/mnt/p/My Audiobooks/` ani z `_Astronomie`/`_Pohádky` — zpracované knihy jsou svaté.
- **Archivy smaž až po** úspěšném rozbalení a kontrole obsahu.
- **Audio soubory přepisuj jen tagy** — originální zvuk nikdy nediruj (kromě APIC embed cover, to je metadata operace).
- **Zálohu obálky** — když embedduješ cover do mp3 a `cover.jpg` byl stažený, nech ho v adresáři (nemaž) — slouží jako Finder preview.
- **Kolize** — nikdy nepřepisuj existující cílový adresář; flagni v raw/_unsorted.

## Testování při prvním spuštění

Když je `__raw/` prázdný → vypiš stav a skonči.

Když obsahuje 1 položku, udělej **dry-run**: popiš navrhované kroky a počkej na potvrzení. Teprve od 2+ položek jedeš plně automaticky.

## Reference

- `REFERENCE.md` — vzorce v existující knihovně 115 knih, typické pasti (vnořené struktury, cp1250 tagy, víc-autorské knihy).
