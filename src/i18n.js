// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the Eagle nor the credentials: only our own words, error
// codes, HTTP statuses, the address and the hardware addresses of the meters.
// -----------------------------------------------------------------------------

import { hardwareAddress } from './eagle/model.js';

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (ms >= 60_000) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** "18:02:05 UTC": an instant, never in the local time of a container. */
export const clock = (at) =>
  Number.isFinite(at) ? `${new Date(at).toISOString().slice(11, 19)} UTC` : '-';

/** Our words for an error code of src/eagle/client.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  refused: { en: 'Cloud ID or install code refused', fr: 'Cloud ID ou code d’installation refusé' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  server: { en: 'error of the Eagle', fr: 'erreur de l’Eagle' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  not_xml: { en: 'answer that is not XML', fr: 'réponse qui n’est pas du XML' },
  unknown_answer: {
    en: 'not an answer of a Rainforest Eagle (is it the right address?)',
    fr: 'réponse qui n’est pas celle d’un Rainforest Eagle (est-ce la bonne adresse ?)',
  },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    ['http', 'server', 'refused', 'rate_limited'].includes(err?.code) &&
    Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const meters = (list) => list.map(hardwareAddress).join(', ');

const kwh = (value) => Math.round(value * 1000) / 1000;

const sentences = (lang, list) => list.map((n) => n[lang]).join(' ');
const both = (list) => ({ en: sentences('en', list), fr: sentences('fr', list) });

const indexName = (meter) => ({
  en: `consumption index of meter ${hardwareAddress(meter)}`,
  fr: `index de consommation du compteur ${hardwareAddress(meter)}`,
});

const heldLine = ({ meter, direction, from, to }) =>
  direction === 'down'
    ? {
        en: `${indexName(meter).en}: dropped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `${indexName(meter).fr} : baisse de ${kwh(from)} à ${kwh(to)} kWh, retenue (la dernière valeur acceptée est renvoyée).`,
      }
    : {
        en: `${indexName(meter).en}: jumped from ${kwh(from)} to ${kwh(to)} kWh, held back (not sent to the energy monitoring).`,
        fr: `${indexName(meter).fr} : saut de ${kwh(from)} à ${kwh(to)} kWh, retenu (non envoyé au suivi énergétique).`,
      };

export const T = {
  problem: {
    address_missing: {
      en: 'Enter the IP address of the Eagle, its Cloud ID and its install code in the configuration.',
      fr: 'Saisissez l’adresse IP de l’Eagle, son Cloud ID et son code d’installation dans la configuration.',
    },
    address_invalid: {
      en: 'The address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.60).',
      fr: 'L’adresse n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.60).',
    },
    cloud_id_missing: {
      en: 'Enter the Cloud ID of the Eagle (6 characters, on the label under the gateway).',
      fr: 'Saisissez le Cloud ID de l’Eagle (6 caractères, sur l’étiquette sous la passerelle).',
    },
    cloud_id_invalid: {
      en: 'The Cloud ID is not valid (letters and digits only): copy it again from the label of the Eagle.',
      fr: 'Le Cloud ID n’est pas valide (lettres et chiffres seulement) : recopiez-le depuis l’étiquette de l’Eagle.',
    },
    install_code_missing: {
      en: 'Enter the install code of the Eagle (16 characters, on the label under the gateway).',
      fr: 'Saisissez le code d’installation de l’Eagle (16 caractères, sur l’étiquette sous la passerelle).',
    },
    install_code_invalid: {
      en: 'The install code is not valid (8 to 64 characters, no space nor colon): copy it again from the label of the Eagle.',
      fr: 'Le code d’installation n’est pas valide (8 à 64 caractères, sans espace ni deux-points) : recopiez-le depuis l’étiquette de l’Eagle.',
    },
  },
  connecting: {
    en: 'Reading the Rainforest Eagle…',
    fr: 'Lecture du Rainforest Eagle…',
  },
  /** Not read yet in this start: the next read. */
  waiting: (at) => ({
    en: `Rainforest Eagle: next read at ${clock(at)}.`,
    fr: `Rainforest Eagle : prochaine lecture à ${clock(at)}.`,
  }),
  refused: (address, refusal) => ({
    en: `${address} refuses the Cloud ID or the install code (HTTP ${refusal.status}), or it is no longer the Eagle at this address (check its address in your router). Reads stopped: they never start again by themselves. Check both on the label of the Eagle and save them again, or click "Test the connection" to try once.`,
    fr: `${address} refuse le Cloud ID ou le code d’installation (HTTP ${refusal.status}), ou ce n’est plus l’Eagle à cette adresse (vérifiez son adresse dans votre box). Lectures arrêtées : elles ne reprennent jamais seules. Vérifiez les deux sur l’étiquette de l’Eagle puis enregistrez-les de nouveau, ou cliquez sur « Tester la connexion » pour un essai.`,
  }),
  failing: (address, err, wait) => ({
    en: `${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
    fr: `${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
  }),
  paused: (address, pause, wait) => ({
    en: `${address} asks to wait (${reason(pause).en}): reads paused, new try in ${delay(wait).en}.`,
    fr: `${address} demande d’attendre (${reason(pause).fr}) : lectures en pause, nouvel essai dans ${delay(wait).fr}.`,
  }),
  ok: (count, notes = []) =>
    both([
      {
        en: `Rainforest Eagle answering (${count} electricity meter${count === 1 ? '' : 's'}).`,
        fr: `Le Rainforest Eagle répond (${count} compteur${count > 1 ? 's' : ''} électrique${count > 1 ? 's' : ''}).`,
      },
      ...notes,
    ]),
  notes: {
    noMeter: {
      en: 'The Eagle lists no electricity meter: is it joined to your meter (see its app or its web page)?',
      fr: 'L’Eagle ne liste aucun compteur électrique : est-il appairé à votre compteur (voir son application ou sa page web) ?',
    },
    noDevice: {
      en: 'Create the meter device from the "Discover" tab to receive its values.',
      fr: 'Créez l’appareil du compteur depuis l’onglet « Découverte » pour recevoir ses valeurs.',
    },
    unlinked: (list) => ({
      en: `Not linked to the Eagle right now: ${meters(list)}; its values are not sent (they would be stale).`,
      fr: `Non relié à l’Eagle en ce moment : ${meters(list)} ; ses valeurs ne sont pas envoyées (elles seraient périmées).`,
    }),
    missing: (list) => ({
      en: `Not read this time (error of the Eagle): ${meters(list)}; the other values are up to date.`,
      fr: `Non lu cette fois (erreur de l’Eagle) : ${meters(list)} ; les autres valeurs sont à jour.`,
    }),
    denied: (list) => ({
      en: `The Eagle refuses the query of ${meters(list)} (the device list takes the credentials); its values are left out.`,
      fr: `L’Eagle refuse la lecture de ${meters(list)} (la liste des appareils accepte les identifiants) ; ses valeurs sont laissées de côté.`,
    }),
    gone: (list) => ({
      en: `No longer listed by the Eagle: ${meters(list)}; its device gets no value.`,
      fr: `Plus listé par l’Eagle : ${meters(list)} ; son appareil ne reçoit aucune valeur.`,
    }),
    held: (held) =>
      both([
        ...held.map(heldLine),
        {
          en: 'If it is right, click "Accept the held index" twice in the configuration of the integration (the first click lists, the second accepts exactly what was listed). Saving the configuration accepts nothing.',
          fr: 'Si c’est juste, cliquez deux fois sur « Accepter l’index retenu » dans la configuration de l’intégration (le premier clic liste, le second accepte exactement ce qui a été listé). Enregistrer la configuration n’accepte rien.',
        },
      ]),
  },
  accept: {
    nothing: {
      en: 'No index is held back: nothing to accept.',
      fr: 'Aucun index n’est retenu : rien à accepter.',
    },
    confirm: (held, within) =>
      both([
        {
          en: 'A second click accepts exactly these values:',
          fr: 'Un second clic accepte exactement ces valeurs :',
        },
        ...held.map((h) =>
          h.direction === 'down'
            ? {
                en: `${indexName(h.meter).en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (a drop: 0 kWh counted).`,
                fr: `${indexName(h.meter).fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (une baisse : 0 kWh compté).`,
              }
            : {
                en: `${indexName(h.meter).en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh counted at once).`,
                fr: `${indexName(h.meter).fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh comptés d’un coup).`,
              },
        ),
        {
          en: `Click "Accept the held index" again, after a few seconds and within ${delay(within).en}, to accept them; accept only if this energy was real.`,
          fr: `Cliquez de nouveau sur « Accepter l’index retenu », après quelques secondes et dans les ${delay(within).fr}, pour les accepter ; n’acceptez que si cette énergie est réelle.`,
        },
      ]),
    done: (accepted, changed) =>
      both([
        ...accepted.map((h) => ({
          en: `Accepted: ${indexName(h.meter).en} ${kwh(h.to)} kWh, sent at the next read.`,
          fr: `Accepté : ${indexName(h.meter).fr} ${kwh(h.to)} kWh, envoyé à la prochaine lecture.`,
        })),
        ...(changed.length > 0
          ? [
              {
                en: `Not accepted, the value changed since the first click: ${changed.map((h) => indexName(h.meter).en).join('; ')}. Click again to list it.`,
                fr: `Non accepté, la valeur a changé depuis le premier clic : ${changed.map((h) => indexName(h.meter).fr).join(' ; ')}. Cliquez de nouveau pour la lister.`,
              },
            ]
          : []),
        { en: 'A different value stays held.', fr: 'Une autre valeur reste retenue.' },
      ]),
  },
  test: {
    /** The last read, in short: the meters and their power. */
    ok: (address, reading) => {
      const en = [];
      const fr = [];
      for (const { id } of reading.meters) {
        const power = reading.values.get(id)?.power;
        const value = power === undefined ? '' : ` ${Math.round(power)} W`;
        en.push(`meter ${hardwareAddress(id)}${value}`);
        fr.push(`compteur ${hardwareAddress(id)}${value}`);
      }
      return {
        en: `${address}: Rainforest Eagle, credentials accepted${en.length ? ` (${en.join(', ')})` : ', no electricity meter listed'}.`,
        fr: `${address} : Rainforest Eagle, identifiants acceptés${fr.length ? ` (${fr.join(', ')})` : ', aucun compteur électrique listé'}.`,
      };
    },
    failed: (address, err) => ({
      en: `${address}: ${reason(err).en}.`,
      fr: `${address} : ${reason(err).fr}.`,
    }),
    /** The button never reads sooner than the pace: what is known, and when the next read can be. */
    notNow: (at) => ({
      en: `Not asked now (never faster than the reading interval or a pause): next read possible at ${clock(at)}.`,
      fr: `Non interrogé maintenant (jamais plus vite que l’intervalle de lecture ou une pause) : prochaine lecture possible à ${clock(at)}.`,
    }),
    lastRead: (at) => ({
      en: `Last read at ${clock(at)}.`,
      fr: `Dernière lecture à ${clock(at)}.`,
    }),
    slow: {
      en: 'The Eagle is slow to answer: look at the integration status in a minute.',
      fr: 'L’Eagle tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
    lines: (lines) => both(lines),
  },
};
