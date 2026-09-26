#!/usr/bin/env python3
"""Convierte un libro (PDF, EPUB o TXT) en archivos de audio MP3.

Usa las voces neuronales de Microsoft Edge (edge-tts), que suenan muy naturales
en español. Necesita conexión a internet.

Ejemplos:
    python libro_a_audio.py mi_libro.pdf
    python libro_a_audio.py mi_libro.epub --por-capitulo
    python libro_a_audio.py mi_libro.pdf --voz es-ES-AlvaroNeural --velocidad +15%
    python libro_a_audio.py --voces            # lista las voces en español

Con ElevenLabs (necesita tu API key):
    export ELEVENLABS_API_KEY=sk_...
    python libro_a_audio.py mi_libro.pdf --elevenlabs
    python libro_a_audio.py mi_libro.pdf --elevenlabs OTRO_ID_DE_VOZ
"""

import argparse
import asyncio
import json
import os
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.etree import ElementTree

VOZ_POR_DEFECTO = "es-MX-DaliaNeural"
MAX_CARACTERES = 4000  # tamaño de cada bloque enviado al servicio de voz

ELEVEN_VOZ_POR_DEFECTO = "Q7BPMFMZj2VEioKV2g3U"
ELEVEN_MODELO = "eleven_multilingual_v2"
ELEVEN_MAX_CARACTERES = 2500


# ---------- Lectura de formatos ----------

def limpiar(texto: str) -> str:
    texto = re.sub(r"(\w)-\s*\n\s*([a-záéíóúñü])", r"\1\2", texto)  # palabras cortadas con guion
    return re.sub(r"\s+", " ", texto).strip()


def leer_pdf(ruta: Path) -> list[tuple[str, str]]:
    from pypdf import PdfReader

    lector = PdfReader(str(ruta))
    return [(f"Página {i}", pagina.extract_text() or "") for i, pagina in enumerate(lector.pages, 1)]


class _ExtractorHTML(HTMLParser):
    BLOQUES = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"}

    def __init__(self):
        super().__init__()
        self.partes: list[str] = []
        self.titulo = ""
        self._ignorar = 0
        self._en_titulo = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self._ignorar += 1
        if tag in self.BLOQUES:
            self.partes.append("\n")
        if tag in ("h1", "h2", "h3") and not self.titulo:
            self._en_titulo = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self._ignorar = max(0, self._ignorar - 1)
        if tag in self.BLOQUES:
            # títulos y párrafos sin punto final se leerían pegados a la frase siguiente
            previo = "".join(self.partes[-3:]).rstrip()
            if tag != "br" and previo and not re.search(r"[.!?…:;\"'»”’)\]]$", previo):
                self.partes.append(".")
            self.partes.append("\n")
        if tag in ("h1", "h2", "h3"):
            self._en_titulo = False

    def handle_data(self, data):
        if self._ignorar:
            return
        self.partes.append(data)
        if self._en_titulo:
            self.titulo += data


def leer_epub(ruta: Path) -> list[tuple[str, str]]:
    with zipfile.ZipFile(ruta) as z:
        contenedor = ElementTree.fromstring(z.read("META-INF/container.xml"))
        opf_ruta = next(e for e in contenedor.iter() if e.tag.endswith("rootfile")).get("full-path")
        base = posixpath.dirname(opf_ruta)
        opf = ElementTree.fromstring(z.read(opf_ruta))

        manifiesto = {e.get("id"): e.get("href") for e in opf.iter() if e.tag.endswith("}item")}
        orden = [e.get("idref") for e in opf.iter() if e.tag.endswith("itemref")]
        nombres = set(z.namelist())

        secciones = []
        for idref in orden:
            href = manifiesto.get(idref)
            if not href:
                continue
            ruta_html = posixpath.normpath(posixpath.join(base, href.split("#")[0]))
            if ruta_html not in nombres:
                continue
            extractor = _ExtractorHTML()
            extractor.feed(z.read(ruta_html).decode("utf-8", errors="ignore"))
            titulo = limpiar(extractor.titulo)[:60] or f"Capítulo {len(secciones) + 1}"
            secciones.append((titulo, "".join(extractor.partes)))
        return secciones


def leer_txt(ruta: Path) -> list[tuple[str, str]]:
    return [(ruta.stem, ruta.read_text(encoding="utf-8", errors="ignore"))]


def leer_libro(ruta: Path) -> list[tuple[str, str]]:
    ext = ruta.suffix.lower()
    if ext == ".pdf":
        secciones = leer_pdf(ruta)
    elif ext == ".epub":
        secciones = leer_epub(ruta)
    elif ext == ".txt":
        secciones = leer_txt(ruta)
    else:
        sys.exit(f"Formato no soportado: {ext}. Usa PDF, EPUB o TXT.")
    return [(t, limpiar(x)) for t, x in secciones if limpiar(x)]


# ---------- Texto → audio ----------

def dividir(texto: str, maximo: int = MAX_CARACTERES) -> list[str]:
    """Divide el texto en bloques que terminan en fin de frase."""
    frases = re.findall(r"[^.!?…]+(?:[.!?…]+[\"'»”)\]]*|$)\s*", texto) or [texto]
    bloques, actual = [], ""
    for frase in frases:
        if len(actual) + len(frase) > maximo and actual:
            bloques.append(actual.strip())
            actual = ""
        actual += frase
    if actual.strip():
        bloques.append(actual.strip())
    return bloques


async def sintetizar(texto: str, destino, voz: str, velocidad: str) -> None:
    import edge_tts

    for intento in range(3):
        try:
            comunicador = edge_tts.Communicate(texto, voz, rate=velocidad)
            async for trozo in comunicador.stream():
                if trozo["type"] == "audio":
                    destino.write(trozo["data"])
            return
        except Exception as e:  # errores de red: reintentar
            if intento == 2:
                raise
            print(f"   ⚠ Error ({e}); reintentando…")
            await asyncio.sleep(2 * (intento + 1))


def _velocidad_a_factor(velocidad: str) -> float:
    """Convierte "+15%" en 1.15, limitado al rango que acepta ElevenLabs (0.7–1.2)."""
    try:
        factor = 1 + float(velocidad.strip().rstrip("%")) / 100
    except ValueError:
        sys.exit(f"Velocidad no válida: {velocidad}. Usa algo como +10% o -10%.")
    return min(1.2, max(0.7, factor))


def _pedir_eleven(texto: str, voz: str, api_key: str, velocidad: str) -> bytes:
    cuerpo = {"text": texto, "model_id": ELEVEN_MODELO}
    factor = _velocidad_a_factor(velocidad)
    if factor != 1:
        cuerpo["voice_settings"] = {"speed": factor}
    pedido = Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voz}?output_format=mp3_44100_128",
        data=json.dumps(cuerpo).encode(),
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    try:
        with urlopen(pedido, timeout=120) as respuesta:
            return respuesta.read()
    except HTTPError as e:
        detalle = e.read().decode(errors="ignore")[:300]
        if e.code == 401:
            raise RuntimeError(f"ElevenLabs rechazó la API key (401). {detalle}") from None
        if e.code in (400, 401, 402, 403, 404, 422):
            raise RuntimeError(f"ElevenLabs {e.code}: {detalle}") from None
        raise


async def sintetizar_eleven(texto: str, destino, voz: str, velocidad: str, api_key: str) -> None:
    for intento in range(3):
        try:
            destino.write(await asyncio.to_thread(_pedir_eleven, texto, voz, api_key, velocidad))
            return
        except (HTTPError, URLError, TimeoutError) as e:  # errores de red o 429/5xx: reintentar
            if intento == 2:
                raise
            print(f"   ⚠ Error ({e}); reintentando…")
            await asyncio.sleep(5 * (intento + 1))


def preparar_motor(args):
    """Devuelve (función que sintetiza un bloque, tamaño máximo de bloque, descripción)."""
    if args.elevenlabs:
        api_key = args.api_key or os.environ.get("ELEVENLABS_API_KEY", "").strip()
        if not api_key:
            sys.exit("Falta la API key de ElevenLabs. Usa --api-key sk_... o la variable ELEVENLABS_API_KEY.")

        async def motor(texto, destino):
            await sintetizar_eleven(texto, destino, args.elevenlabs, args.velocidad, api_key)

        return motor, ELEVEN_MAX_CARACTERES, f"ElevenLabs {args.elevenlabs}"

    async def motor(texto, destino):
        await sintetizar(texto, destino, args.voz, args.velocidad)

    return motor, MAX_CARACTERES, args.voz


def nombre_seguro(texto: str) -> str:
    return re.sub(r"[^\w\- ]+", "", texto).strip().replace(" ", "_")[:50] or "seccion"


async def convertir(args) -> None:
    ruta = Path(args.libro)
    if not ruta.exists():
        sys.exit(f"No existe el archivo: {ruta}")

    print(f"📖 Leyendo «{ruta.name}»…")
    secciones = leer_libro(ruta)
    if not secciones:
        sys.exit("No se encontró texto. Si el PDF es escaneado (imágenes), necesita OCR primero.")

    if args.desde or args.hasta:
        desde = (args.desde or 1) - 1
        hasta = args.hasta or len(secciones)
        secciones = secciones[desde:hasta]

    motor, maximo, descripcion = preparar_motor(args)
    salida = Path(args.salida or ruta.with_suffix(""))
    total_car = sum(len(t) for _, t in secciones)
    print(f"   {len(secciones)} secciones · {total_car:,} caracteres · voz {descripcion}")

    if args.por_capitulo:
        salida.mkdir(parents=True, exist_ok=True)
        for i, (titulo, texto) in enumerate(secciones, 1):
            archivo = salida / f"{i:03d}_{nombre_seguro(titulo)}.mp3"
            print(f"🔊 [{i}/{len(secciones)}] {titulo} → {archivo.name}")
            with open(archivo, "wb") as f:
                for bloque in dividir(texto, maximo):
                    await motor(bloque, f)
        print(f"✅ Listo: carpeta {salida}/")
    else:
        archivo = salida.with_suffix(".mp3")
        bloques = [b for _, texto in secciones for b in dividir(texto, maximo)]
        with open(archivo, "wb") as f:
            for i, bloque in enumerate(bloques, 1):
                print(f"🔊 Generando audio {i}/{len(bloques)} ({i * 100 // len(bloques)} %)", end="\r")
                await motor(bloque, f)
        print(f"\n✅ Listo: {archivo}")


async def listar_voces() -> None:
    import edge_tts

    voces = await edge_tts.list_voices()
    for v in sorted(voces, key=lambda v: v["ShortName"]):
        if v["Locale"].startswith("es"):
            print(f"{v['ShortName']:<28} {v['Gender']:<7} {v['Locale']}")


def main() -> None:
    p = argparse.ArgumentParser(description="Convierte un libro PDF/EPUB/TXT en audio MP3.")
    p.add_argument("libro", nargs="?", help="ruta al archivo PDF, EPUB o TXT")
    p.add_argument("-o", "--salida", help="nombre del MP3 (o carpeta con --por-capitulo)")
    p.add_argument("-v", "--voz", default=VOZ_POR_DEFECTO, help=f"voz a usar (por defecto {VOZ_POR_DEFECTO})")
    p.add_argument("-r", "--velocidad", default="+0%", help="velocidad, p. ej. +20%% o -10%%")
    p.add_argument("-c", "--por-capitulo", action="store_true", help="un MP3 por capítulo/página")
    p.add_argument("--desde", type=int, help="primera sección (página/capítulo) a convertir")
    p.add_argument("--hasta", type=int, help="última sección a convertir")
    p.add_argument("-e", "--elevenlabs", nargs="?", const=ELEVEN_VOZ_POR_DEFECTO, metavar="ID_VOZ",
                   help=f"usar ElevenLabs (voz por defecto {ELEVEN_VOZ_POR_DEFECTO})")
    p.add_argument("--api-key", help="API key de ElevenLabs (o variable ELEVENLABS_API_KEY)")
    p.add_argument("--voces", action="store_true", help="lista las voces disponibles en español")
    args = p.parse_args()

    try:
        if args.voces:
            asyncio.run(listar_voces())
        elif args.libro:
            asyncio.run(convertir(args))
        else:
            p.print_help()
    except ImportError as e:
        sys.exit(f"Falta una librería ({e.name}). Instálalas con:  pip install -r requirements.txt")
    except KeyboardInterrupt:
        sys.exit("\nCancelado.")
    except Exception as e:
        sys.exit(f"\n❌ Error: {e}\n   Revisa tu conexión a internet (la voz se genera en línea).")


if __name__ == "__main__":
    main()
