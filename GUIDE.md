# yt-storage — Setup Guide / Guía de instalación

*English below / Español más abajo.*

---

## English

A complete walkthrough for someone who has never touched this project: installing it, wiring up a Google Cloud project, and connecting your first YouTube account.

### 1. What this actually is

yt-storage encodes any file as a black-and-white block video, uploads it to YouTube as a private video, and decodes it back byte-for-byte when you ask for it. Three pieces work together:

| Piece | Job |
|---|---|
| `packages/codec` | turns files into video and back |
| `api` | the server: HTTP API, background workers, serves the UI |
| `web` | the browser interface |

Everyone who uses it connects **their own** Google Cloud project and YouTube channel — nothing is shared between users, including quota.

### 2. Before you start

Pick one of two paths. Docker is simpler; native is faster to iterate on if you plan to change the code.

**Docker path** — you only need Docker Desktop (or Docker Engine + Compose) installed and running.

**Native path** — you also need:
- Node.js 25 or newer
- `ffmpeg` and `ffprobe`
- `yt-dlp`
- `deno` — not optional, YouTube's playback JavaScript runs inside it

```bash
brew install yt-dlp deno
```

### 3. Install and start it

**Option A — Docker (recommended for a first run)**

```bash
docker compose up -d --build
```

That's the whole command — no file to copy, no key to generate first.

Once it's running, everything lives at <http://localhost:3000> — the interface at `/`, the API under `/api`.

**Option B — running it natively**

```bash
pnpm install && pnpm rebuild -r
pnpm run redis:up
cp api/.env.example api/.env   # optional; nothing in it is required
pnpm run build
pnpm run api      # terminal 1
pnpm run worker   # terminal 2
```

Two processes on purpose: encoding a file pins a CPU core for minutes, and that can't share a process with the server answering requests.

### 3b. Signing in the first time

The app creates an administrator for itself on first boot:

```
admin@yt-storage.com
Abcd1234
```

Signing in with it takes you straight to **`/setup`**, whose first step is changing that password. Do it there and then.

> **Why it matters:** that password is printed in this guide and in the README, so while it's in place, anyone who can reach the machine — over your LAN, over Tailscale — can sign in. And this app stores cookie jars that authenticate the *whole Google account* behind each YouTube channel you connect, not just YouTube.

To seed your own credentials instead, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first boot; `SEED_ADMIN=false` turns the whole thing off. The account is only created when that email doesn't already exist, so restarting never overwrites a password you've set.

**`SECRET_KEY`** — this key encrypts every credential the app stores: client secrets, refresh tokens, cookie jars. You no longer have to supply one: if it's empty, the app generates one on first boot and writes it to `secret.key` inside its data directory. To bring your own instead:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output into `SECRET_KEY` in your env file. Either way, back it up with the database: losing it means reconnecting every account, and leaking it means whoever has it owns those Google accounts.

Registration is open automatically while the instance has zero users, then closes — set `ALLOW_REGISTRATION=true` in your env file to let more people register after that. Passwords must be at least 8 characters.

### 4. Google Cloud Console — one project per YouTube account

This is the part that trips people up, so it's spelled out in full. You need one Google Cloud project *per YouTube channel* you connect — not one for the whole server. That's because YouTube's upload quota is charged per Cloud project, not per channel: a second channel only gets its own upload budget if it brings its own project.

1. **Create the project.** Go to [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate), name it anything, and create it.
2. **Enable the YouTube Data API.** With that project selected, open [APIs & Services → Library](https://console.cloud.google.com/apis/library/youtube.googleapis.com), search for **YouTube Data API v3**, and click **Enable**.
3. **Set up the OAuth consent screen.** Go to **APIs & Services → Google Auth Platform**. Fill in an app name and support email. You don't need Google's review for this to work — see the publishing status step below.
4. **Add the scopes.** Under the consent screen's scopes section, add:
   - `youtube.upload`
   - `youtube.readonly`
5. **Create the OAuth client.** Go to **Credentials → Create Credentials → OAuth client ID**. Choose application type **Web application**. Under **Authorized redirect URIs**, add exactly:
   ```
   http://localhost:3000/accounts/callback
   ```
   (swap the host/port if you're not running on localhost:3000). Save it — you'll get a **client ID** and **client secret**. Copy both; you'll paste them into the app in the next section.
6. **Set publishing status to "In production" — do this, don't skip it.** Back on the Google Auth Platform overview page, find the publishing status and switch it from **Testing** to **In production**.

   > **Why this step matters:** While a project sits in **Testing**, Google expires its refresh tokens after 7 days — the connected account will silently stop working every week. "In production" without formal verification is fine for this use case; you'll see an "unverified app" warning during login once, and you just click through it.

### 5. Connect a YouTube account in the app

Open **`/setup`** in the app and it walks you through exactly these steps, checking off each one against the instance's real state — so you can close the tab, come back, and carry on where you were.

1. **Log in** to your yt-storage instance at `http://localhost:3000` and change the default password (step 1 of the wizard).
2. **Add the account.** The label plus the client ID and client secret from step 5 above. Step 2 of the wizard, or `POST /accounts`.
3. **Authorize it.** Step 3 sends you through the Google OAuth screen you just configured and brings you back to the wizard.
4. **Give it cookies.** Every video uploaded through the app is private, and downloading a private video needs a logged-in session — a cookie jar, not just the OAuth token. Step 4 of the wizard asks you to paste one line: the `cookie:` header your browser already sends to YouTube.

   Open `youtube.com` in the browser signed in as **the same Google account you authorised in step 3**, press F12, open **Network**, reload, filter by **Doc**, click a row (`you`, `persist_identity` or the page itself), and under **Request Headers** copy the whole value of `cookie:`. Paste it into the wizard and save. The wizard shows a screenshot of that exact panel. Nothing is installed on either side, and `docker compose up` really is the whole install.

   Three details that trip people up. The account has to match: a jar for a different Google account stores fine and then cannot download anything the other one uploaded — so the wizard tells you which account the jar turned out to hold, and you check it. Rows for `gstatic.com`, `ggpht.com` or `googlevideo.com` have no `cookie:` line at all, because they are other domains and the browser sends them no YouTube cookies; that is the wrong row, not a missing header. And the console cannot do this: `document.cookie` does not see `HttpOnly` cookies, and those are exactly the ones that authenticate. DevTools does, which is why the copy happens there. A **Copy → Copy as cURL** of the right row also works if you prefer it.

   The app checks the paste against YouTube before storing it, so a header copied from a signed-out tab fails immediately rather than the day you need a file back, and it tells you which account the jar turned out to be.

   **If you have several Google accounts**, the paste is the session of the profile you copied it from, and a jar authenticates as that profile's *effective* account — nothing can change that: yt-dlp has no account switch, and the header YouTube's own web app uses for this was measured here to change nothing. Give each account a browser profile of its own (Brave → Add profile → sign in to YouTube there) and copy from that one.

   Once the account is set up the same button lives on **Accounts**, one per account. That is where you will use it: a jar expires after a few weeks, the health badge turns `stale`, and re-taking one is the fix.

   If the API runs somewhere with no browser at all, this line does the same capture from your machine and talks back over HTTP:
   ```bash
   YTS_API=http://localhost:3000 YTS_ACCOUNT=<account id> pnpm run cookies
   ```

   Alternative: open a **private/incognito window**, log in to YouTube with that account, export cookies with a Netscape-format extension, and `POST` the file to `/accounts/:id/cookies` — then close the window **without logging out** (logging out kills the session and the exported cookies with it).

> **Security note:** A cookie jar authenticates the entire Google account, not just YouTube — anyone holding it can read Gmail and change the password, no second factor needed. Use a throwaway account that isn't the recovery address for anything else.

### 6. Using it day to day

Upload a file (or a folder — several files become one archive automatically) and it moves through a pipeline: encoded, uploaded privately, YouTube finishes processing it, the app downloads it back and checks the bytes match, and only then are the local copies deleted. Nothing is trusted until it's been read back once.

| Route | What it does |
|---|---|
| `POST /files` | upload — one or several files |
| `GET /files` | your files, with status and progress |
| `GET /files/:id/download` | fetch a file back |
| `POST /files/import` | rebuild the list from a channel |
| `GET /status` | account health and today's remaining upload budget |

**If the file list is empty and it should not be**, press **Rebuild from channel** on the Files page. Every upload writes its filename and hash into the video's description, so the list can be read back off the channel: the videos are found, the rows are recreated, and the exact size and hash of each one are confirmed the first time you download it. Videos that are not yt-storage containers are listed and left alone.

The usual reason for that empty list is not lost data at all. The database is `./data/yt-storage.db` *relative to where the app was started* — from the repo root that is `data/`, from `api/` it is `api/data/`, and under Docker it is a volume inside the container. Three different files, three different lists, same channel. Set `DATABASE_PATH` if you want to be certain which one you are opening.

### 7. Worth knowing before you rely on it

- **One account gets 100 uploads a day** (~1.5 TiB) — YouTube's limit, not a setting you can raise. It clears at midnight US Pacific, not at your midnight.
- **Use a home internet connection, not a server/VPS,** to retrieve files — YouTube blocks datacenter IPs with bot checks.
- **Back up `data/yt-storage.db`** — losing it is recoverable with **Rebuild from channel**, since the filename and hash are embedded in each video and in its description, but that file also holds your accounts and credentials, which nothing can rebuild.
- **This runs against YouTube's Terms of Service.** A couple of personal accounts is unremarkable; running many Cloud projects to multiply quota is the pattern Google's abuse detection looks for. Keep a real backup of anything irreplaceable.

---

## Español

Guía completa para alguien que nunca ha tocado este proyecto: instalarlo, configurar un proyecto de Google Cloud y conectar tu primera cuenta de YouTube.

### 1. Qué es esto exactamente

yt-storage convierte cualquier archivo en un video en blanco y negro por bloques, lo sube a YouTube como video privado, y lo reconstruye byte a byte cuando lo pides de vuelta. Tres piezas trabajan juntas:

| Pieza | Función |
|---|---|
| `packages/codec` | convierte archivos en video y viceversa |
| `api` | el servidor: API HTTP, workers en segundo plano, sirve la interfaz |
| `web` | la interfaz de usuario |

Cada persona que lo usa conecta **su propio** proyecto de Google Cloud y canal de YouTube — nada se comparte entre usuarios, ni siquiera la cuota.

### 2. Antes de empezar

Elige uno de dos caminos. Docker es más simple; nativo es más rápido para iterar si piensas modificar el código.

**Camino Docker** — solo necesitas Docker Desktop (o Docker Engine + Compose) instalado y corriendo.

**Camino nativo** — también necesitas:
- Node.js 25 o superior
- `ffmpeg` y `ffprobe`
- `yt-dlp`
- `deno` — no es opcional, el JavaScript de reproducción de YouTube corre dentro de él

```bash
brew install yt-dlp deno
```

### 3. Instalar y arrancar

**Opción A — Docker (recomendado para la primera vez)**

```bash
docker compose up -d --build
```

Ese es el comando completo — no hay archivo que copiar ni clave que generar antes.

Una vez corriendo, todo vive en <http://localhost:3000> — la interfaz en `/`, la API bajo `/api`.

**Opción B — corriéndolo de forma nativa**

```bash
pnpm install && pnpm rebuild -r
pnpm run redis:up
cp api/.env.example api/.env   # opcional; nada de lo que hay dentro es obligatorio
pnpm run build
pnpm run api      # terminal 1
pnpm run worker   # terminal 2
```

Dos procesos a propósito: codificar un archivo ocupa un núcleo de CPU durante minutos, y eso no puede compartir proceso con el servidor que responde peticiones.

### 3b. Entrar por primera vez

La app crea un administrador para sí misma en el primer arranque:

```
admin@yt-storage.com
Abcd1234
```

Iniciar sesión con esa cuenta te lleva directo a **`/setup`**, cuyo primer paso es cambiar esa contraseña. Hazlo en ese momento.

> **Por qué importa:** esa contraseña está impresa en esta guía y en el README, así que mientras siga puesta, cualquiera que alcance la máquina — por tu red local, por Tailscale — puede entrar. Y esta app guarda frascos de cookies que autentican *toda la cuenta de Google* detrás de cada canal de YouTube que conectes, no solo YouTube.

Para sembrar tus propias credenciales en su lugar, define `ADMIN_EMAIL` y `ADMIN_PASSWORD` antes del primer arranque; `SEED_ADMIN=false` desactiva todo esto. La cuenta solo se crea cuando ese correo no existe todavía, así que reiniciar nunca sobrescribe una contraseña que hayas puesto.

**`SECRET_KEY`** — esta clave cifra todas las credenciales que guarda la app: secretos de cliente, tokens de actualización, cookies. Ya no hace falta que la proporciones: si está vacía, la app genera una en el primer arranque y la escribe en `secret.key` dentro de su directorio de datos. Para poner la tuya:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Pega el resultado en `SECRET_KEY` dentro de tu archivo de entorno. En cualquier caso, respáldala junto con la base de datos: perderla obliga a reconectar todas las cuentas, y filtrarla significa que quien la tenga controla esas cuentas de Google.

El registro se abre automáticamente mientras la instancia tiene cero usuarios, y luego se cierra — define `ALLOW_REGISTRATION=true` en tu archivo de entorno para dejar entrar a más gente después. Las contraseñas deben tener al menos 8 caracteres.

### 4. Google Cloud Console — un proyecto por cuenta de YouTube

Esta es la parte donde la gente suele tropezar, así que va explicada al detalle. Necesitas un proyecto de Google Cloud *por cada canal de YouTube* que conectes — no uno solo para todo el servidor. Esto es porque la cuota de subida de YouTube se cobra por proyecto de Cloud, no por canal: un segundo canal solo obtiene su propio presupuesto de subida si trae su propio proyecto.

1. **Crea el proyecto.** Ve a [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate), ponle cualquier nombre y créalo.
2. **Activa la YouTube Data API.** Con ese proyecto seleccionado, abre [APIs y servicios → Biblioteca](https://console.cloud.google.com/apis/library/youtube.googleapis.com), busca **YouTube Data API v3** y pulsa **Habilitar**.
3. **Configura la pantalla de consentimiento OAuth.** Ve a **APIs y servicios → Google Auth Platform**. Completa un nombre de app y un correo de soporte. No necesitas que Google la revise para que funcione — mira el paso de estado de publicación más abajo.
4. **Añade los alcances (scopes).** En la sección de alcances de la pantalla de consentimiento, agrega:
   - `youtube.upload`
   - `youtube.readonly`
5. **Crea el cliente OAuth.** Ve a **Credenciales → Crear credenciales → ID de cliente de OAuth**. Elige tipo de aplicación **Aplicación web**. En **URIs de redirección autorizados**, añade exactamente:
   ```
   http://localhost:3000/accounts/callback
   ```
   (cambia host/puerto si no corres en localhost:3000). Guarda — obtendrás un **ID de cliente** y un **secreto de cliente**. Copia ambos; los pegarás en la app en la siguiente sección.
6. **Pon el estado de publicación en "En producción" — hazlo, no te lo saltes.** De vuelta en la vista general de Google Auth Platform, busca el estado de publicación y cámbialo de **Pruebas** a **En producción**.

   > **Por qué importa este paso:** Mientras un proyecto está en **Pruebas**, Google hace expirar sus tokens de actualización cada 7 días — la cuenta conectada dejará de funcionar en silencio cada semana. "En producción" sin verificación formal está bien para este uso; verás una advertencia de "app no verificada" una vez al iniciar sesión, y solo tienes que continuar.

### 5. Conectar una cuenta de YouTube en la app

Abre **`/setup`** en la app y te guía exactamente por estos pasos, marcando cada uno contra el estado real de la instancia — así puedes cerrar la pestaña, volver, y seguir donde ibas.

1. **Inicia sesión** en tu instancia de yt-storage en `http://localhost:3000` y cambia la contraseña por defecto (paso 1 del asistente).
2. **Añade la cuenta.** La etiqueta más el ID de cliente y el secreto de cliente del paso 5 anterior. Paso 2 del asistente, o `POST /accounts`.
3. **Autorízala.** El paso 3 te lleva a través de la pantalla de OAuth de Google que acabas de configurar y te devuelve al asistente.
4. **Dale las cookies.** Todo video subido por la app es privado, y descargar un video privado necesita una sesión iniciada — un frasco de cookies, no solo el token OAuth. El paso 4 del asistente te pide pegar una línea: la cabecera `cookie:` que tu navegador ya le manda a YouTube.

   Abre `youtube.com` en el navegador donde tengas iniciada **la misma cuenta de Google que autorizaste en el paso 3**, pulsa F12, abre **Network**, recarga, filtra por **Doc**, haz clic en una fila (`you`, `persist_identity` o la página misma), y en **Request Headers** copia el valor entero de `cookie:`. Pégalo en el asistente y guarda. El asistente enseña una captura de ese mismo panel. No se instala nada en ningún lado, y `docker compose up` es literalmente toda la instalación.

   Tres detalles con los que todo el mundo tropieza. La cuenta tiene que coincidir: un frasco de otra cuenta de Google se guarda sin problema y luego no puede descargar nada de lo que subió la primera — por eso el asistente te dice de qué cuenta resultó ser el frasco, y lo compruebas. Las filas de `gstatic.com`, `ggpht.com` o `googlevideo.com` no tienen ninguna línea `cookie:`, porque son otro dominio y el navegador no les manda cookies de YouTube; eso es fila equivocada, no cabecera que falte. Y la consola no sirve para esto: `document.cookie` no ve las cookies `HttpOnly`, que son justo las que autentican. DevTools sí, y por eso la copia se hace ahí. Un **Copy → Copy as cURL** de la fila correcta también vale, si lo prefieres.

   La app comprueba lo pegado contra YouTube antes de guardarlo, así que una cabecera copiada de una pestaña sin sesión falla al momento y no el día que necesites recuperar un archivo, y además te dice de qué cuenta resultó ser el frasco.

   **Si tienes varias cuentas de Google**, lo pegado es la sesión del perfil del que lo copiaste, y un frasco autentica como la cuenta *efectiva* de ese perfil — nada lo cambia: yt-dlp no tiene selector de cuenta, y la cabecera que usa la web de YouTube para esto se midió aquí y no cambia nada. Dale a cada cuenta un perfil de navegador propio (Brave → Añadir perfil → iniciar sesión en YouTube ahí) y copia desde ese.

   Una vez configurada la cuenta, el mismo botón vive en **Accounts**, uno por cuenta. Ahí es donde lo vas a usar: un frasco caduca a las pocas semanas, la insignia de salud pasa a `stale`, y volver a capturarlo es el arreglo.

   Si la API corre en un sitio sin navegador alguno, esta línea hace la misma captura desde tu máquina y habla de vuelta por HTTP:
   ```bash
   YTS_API=http://localhost:3000 YTS_ACCOUNT=<id de la cuenta> pnpm run cookies
   ```

   Alternativa: abre una **ventana privada/incógnito**, inicia sesión en YouTube con esa cuenta, exporta las cookies con una extensión en formato Netscape, y haz `POST` del archivo a `/accounts/:id/cookies` — luego cierra la ventana **sin cerrar sesión** (cerrar sesión mata la sesión y las cookies exportadas con ella).

> **Nota de seguridad:** Un frasco de cookies autentica toda la cuenta de Google, no solo YouTube — quien lo tenga puede leer Gmail y cambiar la contraseña, sin necesitar segundo factor. Usa una cuenta desechable que no sea la dirección de recuperación de ninguna otra cosa.

### 6. Uso del día a día

Sube un archivo (o una carpeta — varios archivos se convierten automáticamente en un solo archivo comprimido) y avanza por una tubería: se codifica, se sube en privado, YouTube termina de procesarlo, la app lo descarga de vuelta y verifica que los bytes coincidan, y solo entonces se borran las copias locales. Nada se da por bueno hasta haberse leído de vuelta una vez.

| Ruta | Qué hace |
|---|---|
| `POST /files` | subir — uno o varios archivos |
| `GET /files` | tus archivos, con estado y progreso |
| `GET /files/:id/download` | traer de vuelta un archivo |
| `POST /files/import` | reconstruir la lista desde un canal |
| `GET /status` | estado de las cuentas y presupuesto de subida restante hoy |

**Si la lista de archivos sale vacía y no debería**, pulsa **Rebuild from channel** en la página de Files. Cada subida escribe el nombre del archivo y su hash en la descripción del video, así que la lista se puede leer de vuelta desde el canal: se encuentran los videos, se recrean las filas, y el tamaño y el hash exactos se confirman la primera vez que descargas cada uno. Los videos que no son contenedores de yt-storage se listan y se dejan en paz.

La causa habitual de esa lista vacía no es pérdida de datos. La base de datos es `./data/yt-storage.db` *relativa al directorio desde donde arrancaste la app* — desde la raíz del repo es `data/`, desde `api/` es `api/data/`, y en Docker es un volumen dentro del contenedor. Tres archivos distintos, tres listas distintas, el mismo canal. Fija `DATABASE_PATH` si quieres estar seguro de cuál abres.

### 7. Vale la pena saber esto antes de confiar en ello

- **Una cuenta permite unas seis subidas al día** (~90 GiB) — es la cuota de YouTube, no un ajuste que puedas subir.
- **Usa una conexión de internet doméstica, no un servidor/VPS,** para descargar archivos — YouTube bloquea IPs de centros de datos con verificaciones anti-bot.
- **Respalda `data/yt-storage.db`** — perderlo es recuperable con **Rebuild from channel**, ya que el nombre y el hash quedan grabados dentro de cada video y en su descripción, pero ese archivo también guarda tus cuentas y credenciales, y eso no lo reconstruye nada.
- **Esto va en contra de los Términos de Servicio de YouTube.** Un par de cuentas personales pasa desapercibido; usar muchos proyectos de Cloud para multiplicar la cuota es el patrón que busca la detección de abuso de Google. Mantén un respaldo real de todo lo irremplazable.
