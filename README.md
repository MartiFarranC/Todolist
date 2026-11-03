# Ara

Una TODO list pensada per al TDA: et mostra **una tasca, la que toca ara**. Claude ordena les tasques i programa els avisos; tu només fas.

## Posada en marxa (una sola vegada)
1. **Supabase**: fem servir el mateix projecte que ProjectBuddy, amb taules pròpies (`todo_*`). Al *SQL Editor* d'aquest projecte enganxa `supabase/schema.sql` i prem *Run*. Copia els dos valors que surten al final (`claude_key` i `ntfy_topic`).
2. **Usuari**: entra amb el mateix correu i contrasenya que a ProjectBuddy. Només aquest correu (configurat a `todo_private.config`) pot veure les tasques.
3. **config.js**: ja hi ha l'URL i la clau pública de ProjectBuddy.
4. **GitHub Pages**: Settings → Pages → *Deploy from a branch* → `main` / root.
5. **Funció d'avisos** (una vegada): Supabase → *Edge Functions* → *Deploy a new function* → *Via Editor*.
   Nom: `todo-push`. Enganxa-hi `supabase/functions/todo-push/index.ts` i prem *Deploy*.
   Després, a *Details* de la funció, desactiva *Verify JWT* (la funció es protegeix sola).
   Amb la CLI: `supabase functions deploy todo-push --no-verify-jwt`.
6. **Instal·la l'app**: obre-la al mòbil amb Chrome → menú ⋮ → *Instal·la l'aplicació*
   (a l'iPhone: Safari → Compartir → *Afegeix a la pantalla d'inici*).
7. **Avisos**: obre l'app instal·lada i prem *Activar* quan pregunti. Ja no cal ntfy:
   només es fa servir si no hi ha cap mòbil amb els avisos activats.

## Avisos
- `normal`: sense so. `important` i el resum del matí: amb so. `urgent`: es queda a la pantalla fins que el toques.
- Els avisos d'una tasca porten els botons **Fet** i **Més tard** (Android). Tocar-lo obre l'app amb aquella tasca.
- L'iPhone no mostra botons ni respecta "sense so" (tots sonen igual), i només funciona amb l'app afegida a l'inici.
- Cap avís web pot saltar-se el *No molestar* del mòbil.

## Dreceres
A Android, mantén premuda la icona d'Ara: *Apunta una cosa* i *Horari*.

## Widget a la pantalla d'inici (Android)
Una web app no pot crear widgets propis (ni a Android ni a iPhone). La drecera és **KWGT**, una app gratuïta
de widgets que llegeix la tasca d'ara d'aquesta adreça (`widget_key` surt al final de `schema.sql`):

```
https://mjdbqbcyensvyvhzegrc.supabase.co/functions/v1/todo-push?widget=<widget_key>
```

1. Instal·la **KWGT Kustom Widget Maker** (Play Store).
2. Mantén premut un espai buit de la pantalla d'inici → *Widgets* → *KWGT* → el de 4×1 o 4×2.
3. Toca el widget buit → *+* → *Text*. Al camp *Text* posa: `$wg("ADREÇA", json, ".text")$`
4. Un altre *Text* a sota, més petit: `$wg("ADREÇA", json, ".sub")$`
5. Pestanya *Touch* del widget → *Launch App* → **Ara**. Desa (icona del disquet).

Mostra la tasca d'ara i el primer pas. Durant una rutina mostra la rutina i fins a quina hora.
Només llegeix: la clau del widget no permet canviar res.

Detalls tècnics i com Claude hi escriu: vegeu `CLAUDE.md`.
