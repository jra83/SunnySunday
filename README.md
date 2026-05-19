# ☀️ Sunny Sunday

Application web d'analyse d'ensoleillement et de masque d'ombrage pour des
parcelles en France, à partir des données IGN.

Le calcul est réalisé **100 % dans le navigateur** : la recherche d'adresse,
le MNT, l'orthophoto et les bâtiments sont récupérés directement depuis les
services IGN, puis l'ensoleillement et les ombres sont calculés en JavaScript.
L'hébergement ne sert que des fichiers statiques.

## Utilisation

Ouvrir la page, rechercher une adresse, placer un point sur la carte puis
lancer le calcul d'ensoleillement. La vue 3D affiche le terrain, les bâtiments
et les ombres, avec des curseurs heure / jour.

## Lancer en local

Servir le dossier avec n'importe quel serveur statique, par exemple :

```
python -m http.server 8000
```

puis ouvrir <http://localhost:8000>.
