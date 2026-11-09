# Ara · TODO list per a TDA

App d'Android (WebView amb la web de `web/` + avisos, widget i dreceres natius) + Supabase. El Martí té TDA: l'objectiu és fricció mínima i calma.
Parla-li en català, amb frases curtes.
Treballa directament a `main` (commit i push). Sense branques ni PR, tret que el Martí ho demani.

## Principis de disseny (no els trenquis)
- La pantalla principal mostra **una sola tasca**. Res de llistes llargues per defecte.
- Sense vermell, sense comptadors de tasques endarrerides, sense ratxes ni culpa.
- Un sol color d'accent, molt d'espai, animacions curtes i desactivables (`prefers-reduced-motion`).
- Màxim 3 avisos per tasca, límit diari, hores de silenci. Text d'avís = verb + primer pas.

## Com afegir i reordenar tasques des del xat
Variables d'entorn necessàries (secrets de l'entorn): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TODO_CLAUDE_KEY`.
Totes les crides són RPC protegides per `TODO_CLAUDE_KEY` (vegeu `supabase/schema.sql`).
El projecte de Supabase és el mateix que el de ProjectBuddy (`mjdbqbcyensvyvhzegrc`), però tot el de la todolist
porta el prefix `todo_` (taules `todo_tasks`, `todo_reminders`, `todo_schedule_blocks`, esquema `todo_private`).
No toquis mai les taules de ProjectBuddy.

```bash
rpc() { curl -sS "$SUPABASE_URL/rest/v1/rpc/todo_claude_$1" -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" -d "$2"; }

# Llistar tasques actives (inclou la safata 'inbox' que el Martí apunta des de l'app)
rpc list "{\"key\":\"$TODO_CLAUDE_KEY\"}"

# Crear una tasca (sense id) o actualitzar-la (amb id; només canvien els camps enviats)
rpc upsert_task "{\"key\":\"$TODO_CLAUDE_KEY\",\"task\":{
  \"title\":\"Trucar al dentista\", \"first_step\":\"Obre el mòbil i busca 'dentista'\",
  \"importance\":3, \"energy\":\"low\", \"estimate_min\":5,
  \"due_at\":\"2026-11-05T12:00:00+01:00\"}}"

# Fixar l'ordre complet (posició = prioritat). Passa també les de la safata per classificar-les.
rpc set_order "{\"key\":\"$TODO_CLAUDE_KEY\",\"ids\":[\"<id1>\",\"<id2>\"]}"

# Avisos d'una tasca (substitueix els pendents; màxim 3). task_id null = avís solt.
rpc set_reminders "{\"key\":\"$TODO_CLAUDE_KEY\",\"task_id\":\"<id>\",\"reminders\":[
  {\"remind_at\":\"2026-11-05T11:00:00+01:00\",\"level\":\"normal\"},
  {\"remind_at\":\"2026-11-05T11:50:00+01:00\",\"level\":\"important\",\"message\":\"Primer pas: obre el mòbil\"}]}"

# Esborrar, o canviar configuració (quiet_start, quiet_end, daily_limit, digest_time)
rpc delete_task "{\"key\":\"$TODO_CLAUDE_KEY\",\"id\":\"<id>\"}"
rpc config "{\"key\":\"$TODO_CLAUDE_KEY\",\"changes\":{\"daily_limit\":5}}"
```

## Horari del Martí
- Feina: de dilluns a divendres, 9:00 a 13:00.
- Gimnàs: de dilluns a divendres, 16:30 a 17:30.
- 30 min de marge abans i després de cada rutina (desplaçar-se o preparar-se).
- L'horari viu a la taula `todo_schedule_blocks` (el Martí l'edita des de la pantalla Horari de l'app).
  Durant un bloc amb `busy = true`, els avisos normals i importants esperen.
  Llegeix-lo abans de programar res: `rpc schedule "{\"key\":\"$TODO_CLAUDE_KEY\"}"`.
  Substituir-lo sencer: afegeix `\"blocks\":[{\"label\":\"Feina\",\"days\":[1,2,3,4,5],\"start_time\":\"09:00\",\"end_time\":\"13:00\"}]`.
- Cada rutina té un marge (`buffer_min`, per defecte 30 min) abans i després per preparar-se i desplaçar-se.
  Aquest marge també compta com a ocupat.
- No programis tasques dins de rutines ni dels seus marges: fes servir `start_at` per fer-les aparèixer després
  (p. ex. feina 9–13 → la tarda comença a les 13:30; gimnàs 16:30–17:30 → lliure de 18:00).

## F1 i MotoGP
- L'app mostra totes les sessions (lliures, pràctica, classificació, sprint i cursa) com a rutines,
  amb el color de cada campionat (F1 terracota, MotoGP blau) i una etiqueta.
- Font: github.com/sportstimes/f1 (`_db/f1/<any>.json`, `_db/motogp/<any>.json`), llegida en directe des del navegador.
  Si falla, es fa servir la còpia de `web/data/`. Actualitza-la a l'inici de cada temporada.
- No bloquegen avisos ni tenen marge. No programis tasques importants a sobre d'una cursa o sprint.

## Com prioritzar
1. Primer el que té data límit propera o conseqüències si no es fa (importance 3).
2. Barreja tasques fàcils (energy low) entre les difícils per mantenir l'impuls.
3. Cada tasca: títol que comenci amb un verb, `first_step` de menys de 5 minuts, `estimate_min` realista.
4. Tasques grans: crea passos amb `parent_id` (el pare s'amaga fins que s'acaben els passos).
5. Si una tasca té `snooze_count` alt, pregunta si es pot partir, delegar o eliminar. Sense jutjar.
6. Avisos: només per a coses amb hora o data real. Les tasques sense hora no porten avís (ja surten al resum del matí).
   Nivells: `normal` (silenciós), `important` (so), `urgent` (salta el No molestar i les hores de silenci; fer-lo servir molt poc).
7. Terminis ("s'ha de fer aquesta setmana / el mes que ve"): `start_at` = inici de la finestra (p. ex. dia 1 a les 00:00),
   `due_at` = final (p. ex. dia 30 a les 23:59). No cal posar avisos: a mesura que s'acosta `due_at`, la tasca puja sola
   (nivell 2–3 passa davant del `rank`) i rep un record al dia a partir de `nudge_time` (18:00), primer sense so i després amb so.
   Nivells (`todo_private.urgency` i `Logic.urgency`): 1 = queda ≤ meitat o < 7 dies, 2 = ≤ un quart o < 3 dies, 3 = < 1 dia.
8. Hora local: Europe/Madrid. Envia sempre les dates amb el desplaçament (+01:00 / +02:00).

## Estructura
- `web/`: la interfície. `index.html`, `style.css`, `app.js` (UI), `logic.js` (ordre i textos, sense DOM),
  `config.js` (URL i anon key públiques), `vendor/` (supabase-js, sense CDN), `data/` (F1 i MotoGP).
  Ja no és una PWA ni hi ha GitHub Pages: l'app d'Android l'empaqueta dins l'APK.
- `android/`: projecte d'Android Studio (Kotlin, paquet `cat.martifarran.ara`). Obre `android/` a Android Studio.
  - `MainActivity.kt`: WebView que serveix `web/` a `https://appassets.androidplatform.net/assets/index.html`.
    La web parla amb Android amb `window.AraNative` (testimoni de Firebase, permís d'avisos, clau del widget).
    Android crida la web amb `araIntent(query)`, `araOnToken()`, `araOnPermission(bool)` i `araBack()`.
  - `PushService.kt` + `Notifier.kt`: reben els avisos de Firebase (missatges de dades) i els mostren amb un canal per nivell
    (`normal`, `important`, `digest`, `urgent`) i botons Fet / Més tard (obren `ara://open?task=<id>&do=done|later`).
  - `NowWidget.kt` + `WidgetWorker.kt`: widget natiu que llegeix `todo-push?widget=<widget_key>`.
    L'app obté la clau amb `rpc('todo_app_widget_key')` (només el propietari).
  - Dreceres: `res/xml/shortcuts.xml` (`ara://open?capture=1`, `ara://open?view=schedule`).
  - `app/google-services.json` no es puja (cada un el descarrega de Firebase). Sense ell compila però no rep avisos.
- `supabase/schema.sql`: taules, RLS, API per a Claude i enviament d'avisos (pg_cron cada minut).
  Push si hi ha dispositius a `todo_push_subscriptions` (l'app d'Android desa `endpoint = 'fcm:<token>'`);
  si no, ntfy com a reserva. `supabase/android.sql` i `supabase/terminis.sql`: canvis solts per executar sobre una base ja creada.
- `supabase/functions/todo-push/index.ts`: Edge Function (sense JWT). Envia per FCM (API v1, secret
  `FCM_SERVICE_ACCOUNT` amb el JSON del compte de servei) als `fcm:` i per Web Push als altres.
  `GET ?widget=<widget_key>` torna la tasca d'ara per al widget.
