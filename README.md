# Ara

Una TODO list pensada per al TDA: et mostra **una tasca, la que toca ara**. Claude ordena les tasques i programa els avisos; tu només fas.

## Posada en marxa (una sola vegada)
1. **Supabase**: fem servir el mateix projecte que ProjectBuddy, amb taules pròpies (`todo_*`). Al *SQL Editor* d'aquest projecte enganxa `supabase/schema.sql` i prem *Run*. Copia els dos valors que surten al final (`claude_key` i `ntfy_topic`).
2. **Usuari**: entra amb el mateix correu i contrasenya que a ProjectBuddy. Només aquest correu (configurat a `todo_private.config`) pot veure les tasques.
3. **config.js**: ja hi ha l'URL i la clau pública de ProjectBuddy.
4. **GitHub Pages**: Settings → Pages → *Deploy from a branch* → `main` / root.
5. **Avisos**: instal·la l'app [ntfy](https://ntfy.sh) al mòbil i subscriu-te al tema `ntfy_topic`.
6. Obre l'app al mòbil i *Afegeix a la pantalla d'inici*.

Detalls tècnics i com Claude hi escriu: vegeu `CLAUDE.md`.
