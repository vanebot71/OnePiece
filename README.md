# OnePiece — Lector de libros en voz alta 📖🔊

Convierte tus **PDF, EPUB o TXT** en audio. Incluye dos herramientas:

| | App web (`index.html`) | Script (`libro_a_audio.py`) |
|---|---|---|
| Para qué | Escuchar el libro al momento en el navegador | Generar archivos **MP3** para escuchar donde quieras |
| Instalación | Ninguna | Python 3.9+ |
| Voz | Las voces de tu sistema / navegador | Voces neuronales de Microsoft (muy naturales) |
| Internet | Solo para cargar la página | Sí, para generar la voz |

---

## 1. App web: escuchar en el navegador

1. Abre `index.html` en Chrome, Edge o Safari (doble clic, o publícala con GitHub Pages).
2. Arrastra tu libro o haz clic para elegirlo.
3. Pulsa ▶.

Funciones:
- Resalta la frase que se está leyendo y hace scroll automático.
- Toca cualquier frase para empezar a leer desde ahí.
- Elige voz (las voces en español aparecen primero), velocidad y tono.
- Salta por páginas (PDF) o capítulos (EPUB).
- **Recuerda dónde te quedaste** en cada libro.
- Controles desde auriculares / pantalla de bloqueo (en navegadores compatibles).

> 💡 En Edge las voces "Online (Natural)" suenan mucho mejor. En Android/iPhone
> puedes instalar más voces en español desde los ajustes de texto a voz del sistema.

### Publicarla en internet (gratis) con GitHub Pages
En GitHub: **Settings → Pages → Branch: `main` / root → Save**. Tendrás la app en
`https://<tu-usuario>.github.io/OnePiece/` y podrás usarla desde el celular.

---

## 2. Script: convertir el libro a MP3

```bash
pip install -r requirements.txt

# Todo el libro en un solo MP3 (mi_libro.mp3)
python libro_a_audio.py mi_libro.pdf

# Un MP3 por capítulo (EPUB) o por página (PDF), en la carpeta mi_libro/
python libro_a_audio.py mi_libro.epub --por-capitulo

# Elegir voz y velocidad
python libro_a_audio.py mi_libro.pdf --voz es-ES-AlvaroNeural --velocidad +15%

# Solo las páginas 10 a 25
python libro_a_audio.py mi_libro.pdf --desde 10 --hasta 25

# Ver todas las voces en español
python libro_a_audio.py --voces
```

Algunas voces: `es-MX-DaliaNeural` (por defecto), `es-MX-JorgeNeural`,
`es-ES-ElviraNeural`, `es-ES-AlvaroNeural`, `es-AR-TomasNeural`, `es-CO-SalomeNeural`.

---

## Limitaciones
- **PDF escaneados** (fotos de páginas) no tienen texto: hay que pasarles OCR primero
  (por ejemplo con `ocrmypdf`).
- Los EPUB con DRM (comprados en tiendas) no se pueden abrir.
- En la app web el audio se reproduce en vivo; para guardar archivos de audio usa el script.
