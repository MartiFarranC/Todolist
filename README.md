# Ara

Una TODO list pensada per al TDA: et mostra **una tasca, la que toca ara**. Claude ordena les tasques i programa els avisos; tu només fas.

## Posada en marxa (una sola vegada)
1. **Supabase**: crea un projecte. Al *SQL Editor* enganxa `supabase/schema.sql` i prem *Run*. Copia els dos valors que surten al final (`claude_key` i `ntfy_topic`).
2. **Usuari**: a *Authentication → Users → Add user*, crea't amb el teu correu i una contrasenya (marca *Auto confirm*). Després, a *Authentication → Sign In / Providers*, desactiva *Allow new users to sign up*.
3. **config.js**: posa-hi l'URL del projecte i la *anon key* (Project Settings → API).
4. **GitHub Pages**: Settings → Pages → *Deploy from a branch* → `main` / root.
5. **Avisos**: instal·la l'app [ntfy](https://ntfy.sh) al mòbil i subscriu-te al tema `ntfy_topic`.
6. Obre l'app al mòbil i *Afegeix a la pantalla d'inici*.

Detalls tècnics i com Claude hi escriu: vegeu `CLAUDE.md`.
