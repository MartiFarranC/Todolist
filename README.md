# Ara

Una TODO list pensada per al TDA: et mostra **una tasca, la que toca ara**. Claude ordena les tasques i programa els avisos; tu només fas.

És una **app d'Android** (carpeta `android/`). La interfície és la web de `web/`, empaquetada dins l'app;
els avisos, el widget i les dreceres són natius. Les dades són a Supabase (taules `todo_*`).

## Posada en marxa (una sola vegada)

### 1. Supabase
Fem servir el mateix projecte que ProjectBuddy, amb taules pròpies (`todo_*`).
- Si és la primera vegada: al *SQL Editor* enganxa `supabase/schema.sql` i prem *Run*.
- Si ja ho tenies: només enganxa `supabase/android.sql` i prem *Run* (afegeix una funció per al widget).

### 2. Firebase (per als avisos)
Android fa arribar els avisos amb Firebase Cloud Messaging. És gratis.
1. Ves a <https://console.firebase.google.com> → *Crea un projecte* → nom `Ara` (Analytics no cal).
2. Dins el projecte: icona d'Android (*Afegeix una app*) → nom del paquet: `cat.martifarran.ara` → *Registra*.
3. Descarrega `google-services.json` i posa'l a `android/app/` (no es puja a GitHub).
4. ⚙️ *Configuració del projecte* → *Comptes de servei* → *Genera una clau privada nova*. Es descarrega un JSON.
5. Supabase → *Edge Functions* → *Secrets* → *Add new secret*:
   nom `FCM_SERVICE_ACCOUNT`, valor: tot el contingut d'aquest JSON.
6. Supabase → *Edge Functions* → `todo-push` → *Code*: enganxa `supabase/functions/todo-push/index.ts` → *Deploy*.
   (*Verify JWT* ha de continuar desactivat.)

### 3. L'app
1. Android Studio → *Open* → tria la carpeta `android/` del repo. Espera que acabi el *Gradle sync*.
2. Connecta el mòbil (depuració USB o sense fil) i prem ▶ *Run*.
3. Entra amb el mateix correu i contrasenya que a ProjectBuddy.
4. Prem *Activar* quan pregunti pels avisos.

Per tenir l'APK: *Build* → *Build App Bundle(s) / APK(s)* → *Build APK(s)*.

Si tenies la PWA antiga instal·lada, esborra-la (mantén premuda la icona → *Desinstal·la*).
L'app ja treu les subscripcions de la PWA perquè no arribin avisos repetits.

## Avisos
- Quatre canals, que pots ajustar a *Ajustos → Apps → Ara → Notificacions*:
  **Avisos tranquils** (`normal`, sense so), **Avisos importants** (so), **Resum del matí** i **Urgents**.
- Els *Urgents* es queden fins que els toques. Per fer que saltin el *No molestar*, obre aquest canal i activa
  *Ignora No molestar*.
- Els avisos d'una tasca porten els botons **Fet** i **Més tard**. Tocar-lo obre l'app amb aquella tasca.
- Les hores de silenci, el límit diari i l'horari els decideix Supabase (no el mòbil).
- Si encara no hi ha Firebase, Supabase envia els avisos per ntfy, com abans.

## Widget
Mantén premut un espai buit de la pantalla d'inici → *Widgets* → **Ara**.
Mostra la tasca d'ara i el primer pas; durant una rutina, la rutina i fins a quina hora.
S'actualitza quan surts de l'app, quan arriba un avís i cada 15 minuts. Tocar-lo obre l'app.

## Dreceres
Mantén premuda la icona d'Ara: *Apunta una cosa* i *Horari*.

## Provar la web a l'ordinador
`web/` també funciona en un navegador (sense avisos ni widget): `cd web && python3 -m http.server`.

Detalls tècnics i com Claude hi escriu: vegeu `CLAUDE.md`.
