# Rainforest Eagle

Intégration **non officielle**, sans lien avec Rainforest Automation. Elle lit
votre passerelle d'énergie **Rainforest Eagle-200** ou **Eagle-3** (la
passerelle Zigbee qui lit le compteur électrique communicant de nombreux
fournisseurs aux États-Unis et au Canada) sur votre réseau local, par son API
locale (HTTP), avec le Cloud ID et le code d'installation imprimés sur son
étiquette, sans cloud.

**Jamais testé avec un vrai appareil** : l'intégration a été écrite d'après la
bibliothèque [aioeagle](https://github.com/home-assistant-libs/aioeagle)
(celle de Home Assistant), sans Eagle sous la main. L'Eagle-3 devrait répondre
comme l'Eagle-200 (même API locale), ce n'est pas vérifié. L'ancien Eagle-100
(une autre API) n'est pas pris en charge. Vos retours sont les bienvenus.

## Lecture seule

L'intégration **ne fait que lire** (les commandes `device_list` et
`device_query` de l'API locale). Elle ne change jamais rien sur la passerelle
ni sur le compteur (ni prix, ni confirmation de message, ni réglage).

## Ce que vous obtenez

Un appareil par compteur électrique lu par l'Eagle (nommé « Eagle meter » et
son adresse matérielle, ex. `0x00abcd123`) :

- **puissance** (W) : la demande instantanée du compteur, **négative** quand
  la maison envoie de l'énergie au réseau (solaire) ;
- **index de consommation** (kWh) : l'énergie que le compteur a fournie à la
  maison, pour le suivi énergétique de Gladys (Gladys en calcule elle-même la
  consommation et le coût) ;
- **énergie envoyée au réseau** (kWh, total) : un simple capteur, **jamais**
  compté comme une consommation.

### Suivi énergétique

L'index de consommation est l'énergie prise au réseau, mesurée par le
compteur de votre fournisseur. Si une autre intégration envoie déjà ce même
compteur à Gladys (une autre passerelle, un compte fournisseur), **ne gardez
qu'une source**, sinon la consommation est comptée deux fois. L'intégration
n'envoie jamais de consommation journalière.

## Prérequis

- Gladys 5.2.0 ou plus récent.
- L'Eagle sur le même réseau que Gladys, son API locale joignable en HTTP
  (port 80), déjà appairé à votre compteur (voir son application).
- Le **Cloud ID** (6 caractères) et le **code d'installation** (16
  caractères) : sur l'étiquette sous la passerelle.

## Configuration

1. Installez l'intégration depuis le store de Gladys.
2. **Adresse IP de l'Eagle** : son adresse sur votre réseau (avec `:port`
   seulement si ce n'est pas 80). Donnez-lui de préférence une adresse fixe
   dans votre box (le nom `eagle-<cloud id>.local` ne se résout en général
   pas dans un conteneur).
3. **Cloud ID** : jamais journalisé.
4. **Code d'installation** : gardé par Gladys dans sa base, jamais réaffiché ;
   envoyé seulement à l'Eagle (dans l'en-tête de ses requêtes), jamais
   journalisé.
5. **Intervalle de lecture** : 30 s par défaut, de 30 à 300 s (deux petites
   requêtes par compteur, à une seconde d'intervalle).
6. Après la première lecture, créez l'appareil du compteur depuis l'onglet
   **Découverte**.

Le bouton **Tester la connexion** lit l'Eagle une fois si l'intervalle est
écoulé ; sinon il affiche la dernière lecture et l'heure de la prochaine
possible.

## Rythme des lectures

Rien ne lit l'Eagle plus vite que l'intervalle : ni le bouton de test, ni
l'onglet Découverte, ni une reconnexion à Gladys, ni l'enregistrement d'une
configuration inchangée, ni un redémarrage du conteneur (l'heure de la
dernière lecture est gardée dans `/data`, écrite au plus une fois par minute :
après un redémarrage, la première lecture attend l'intervalle plus une
minute). Une nouvelle adresse ou de nouveaux identifiants sont essayés tout de
suite.

## Index retenu

Gladys compte chaque hausse d'un index en entier. Pour ne jamais compter une
énergie fictive, l'index de consommation passe par une garde :

- une valeur à 0 n'est jamais envoyée ;
- une baisse, ou une hausse plus rapide que 100 kW en moyenne, est
  **retenue** : la dernière valeur acceptée est renvoyée, et l'état de
  l'intégration l'affiche. Ni le temps ni la répétition ne la confirment
  (elle reste retenue après un redémarrage) ;
- si elle est juste, cliquez **deux fois** sur **Accepter l'index retenu** : le
  premier clic liste ce qui est retenu sans rien accepter, le second, de
  3 secondes à 5 minutes plus tard, accepte exactement ce qui a été listé (un
  saut est alors compté d'un coup, une baisse ne compte rien). Enregistrer la
  configuration n'accepte rien.

## Erreurs

- **Identifiants refusés** (HTTP 401/403 de la liste des appareils) : les
  lectures s'arrêtent et **ne reprennent jamais seules** (un mauvais code
  d'installation n'est jamais essayé en boucle) ; cet arrêt est gardé dans
  `/data` après un redémarrage. Enregistrer d'autres identifiants les essaie
  tout de suite ; **Tester la connexion** fait un essai par clic. Pour
  reconnaître des identifiants refusés après un redémarrage, `/data` garde une
  empreinte salée de la paire refusée seulement (jamais d'une paire qui
  fonctionne), effacée à la première lecture réussie.
- Une réponse HTTP 429 ou 5xx de la liste des appareils met l'Eagle en pause
  de 1 minute à 6 heures, gardée dans `/data`. Une erreur de lecture d'un
  compteur laisse seulement ce compteur de côté : les autres sont publiés.
- Un Eagle injoignable est réessayé après 1 minute, puis 2, jusqu'à
  15 minutes, jamais plus vite que l'intervalle.
- Chaque lecture commence par la liste des appareils, avec les identifiants
  de l'étiquette : un autre Eagle qui prendrait l'adresse (DHCP) les refuse et
  ne donne rien ; un autre appareil répond autre chose qu'une réponse d'Eagle,
  rien n'est publié.
- Un compteur que l'Eagle ne joint plus (pas « Connected ») ne publie rien
  (ses valeurs seraient périmées) ; l'état le dit.

## Confidentialité

Rien ne sort de votre réseau : l'intégration ne parle qu'à l'Eagle, en HTTP
local, et ne suit aucune redirection. Le code d'installation circule en clair
sur votre réseau local (HTTP Basic), comme pour tout client de cette API
locale.
