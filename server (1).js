/**
 * VisiSport Backend
 * ------------------
 * Petit serveur qui :
 *  1. Reçoit une demande "analyse-moi ce match" depuis le site VisiSport
 *  2. Va chercher les VRAIES données récentes des deux équipes auprès de l'API-Football
 *  3. Calcule une estimation statistique (score probable, fiabilité, tendances)
 *  4. Renvoie tout ça au site, avec un rappel clair que ce sont des estimations,
 *     pas des garanties.
 *
 * La clé API ne quitte JAMAIS ce serveur : le site public ne la voit jamais.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

if (!API_KEY) {
  console.warn(
    "⚠️  API_FOOTBALL_KEY manquante dans .env — les appels à l'API échoueront."
  );
}

// ---------- Sécurité / configuration de base ----------
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
  })
);
app.use(express.json());

// Limite le nombre de requêtes pour protéger ton quota d'API et éviter les abus
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requêtes / minute / IP
  message: { error: "Trop de requêtes, réessaie dans une minute." },
});
app.use("/api/", limiter);

const apiFootball = axios.create({
  baseURL: "https://v3.football.api-sports.io",
  headers: { "x-apisports-key": API_KEY },
  timeout: 10000,
});

// Petit cache en mémoire pour éviter de re-consommer ton quota d'API
// pour les mêmes équipes demandées plusieurs fois dans la journée.
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 heures

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function setCache(key, value) {
  cache.set(key, { value, time: Date.now() });
}

// ---------- Fonctions utilitaires ----------

/** Cherche une équipe par son nom et renvoie son ID API-Football + nom officiel. */
async function findTeam(name) {
  const cacheKey = "team:" + name.toLowerCase();
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { data } = await apiFootball.get("/teams", { params: { search: name } });
  const results = data.response || [];
  if (!results.length) return null;

  // On prend le premier résultat, généralement le plus pertinent
  const team = {
    id: results[0].team.id,
    name: results[0].team.name,
    logo: results[0].team.logo,
    country: results[0].team.country,
  };
  setCache(cacheKey, team);
  return team;
}

/** Récupère les N derniers matchs joués (terminés) par une équipe. */
async function getRecentForm(teamId, last = 7) {
  const cacheKey = `form:${teamId}:${last}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { data } = await apiFootball.get("/fixtures", {
    params: { team: teamId, last, status: "FT" },
  });
  const fixtures = data.response || [];

  let goalsFor = 0;
  let goalsAgainst = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  const formLetters = [];

  fixtures.forEach((f) => {
    const isHome = f.teams.home.id === teamId;
    const gf = isHome ? f.goals.home : f.goals.away;
    const ga = isHome ? f.goals.away : f.goals.home;
    goalsFor += gf ?? 0;
    goalsAgainst += ga ?? 0;

    if (gf > ga) {
      wins++;
      formLetters.push("V");
    } else if (gf < ga) {
      losses++;
      formLetters.push("D");
    } else {
      draws++;
      formLetters.push("N");
    }
  });

  const count = fixtures.length || 1;
  const result = {
    matchesAnalyzed: fixtures.length,
    avgGoalsFor: +(goalsFor / count).toFixed(2),
    avgGoalsAgainst: +(goalsAgainst / count).toFixed(2),
    wins,
    draws,
    losses,
    form: formLetters, // du plus ancien au plus récent
  };
  setCache(cacheKey, result);
  return result;
}

/** Confrontations directes récentes entre deux équipes. */
async function getHeadToHead(teamId1, teamId2, last = 5) {
  const cacheKey = `h2h:${[teamId1, teamId2].sort().join("-")}:${last}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { data } = await apiFootball.get("/fixtures/headtohead", {
    params: { h2h: `${teamId1}-${teamId2}`, last, status: "FT" },
  });
  const fixtures = data.response || [];
  setCache(cacheKey, fixtures.length);
  return fixtures.length;
}

/**
 * Combine les statistiques réelles des deux équipes en une estimation.
 * C'est un modèle statistique simple (moyenne de buts pondérée) — pas une IA
 * complexe, mais basé sur de vraies données récentes plutôt que du hasard pur.
 */
function computeEstimate(formHome, formAway, h2hCount) {
  // Expected goals = moyenne entre l'attaque de l'un et la défense de l'autre
  const xgHome = (formHome.avgGoalsFor + formAway.avgGoalsAgainst) / 2;
  const xgAway = (formAway.avgGoalsFor + formHome.avgGoalsAgainst) / 2;

  const scoreHome = Math.max(0, Math.round(xgHome));
  const scoreAway = Math.max(0, Math.round(xgAway));

  let winner = "Match nul";
  if (scoreHome > scoreAway) winner = "home";
  else if (scoreAway > scoreHome) winner = "away";

  // Fiabilité : plus on a de matchs analysés et plus l'écart est net,
  // plus le score de fiabilité monte (plafonné pour rester honnête).
  const sampleSize = Math.min(formHome.matchesAnalyzed, formAway.matchesAnalyzed);
  const gap = Math.abs(xgHome - xgAway);
  let fiabilite = 50 + sampleSize * 2 + Math.round(gap * 8) + Math.min(h2hCount, 3) * 2;
  fiabilite = Math.max(45, Math.min(88, fiabilite));

  return {
    predictedScore: `${scoreHome} - ${scoreAway}`,
    winner,
    fiabilite,
    xgHome: +xgHome.toFixed(2),
    xgAway: +xgAway.toFixed(2),
  };
}

// ---------- Routes ----------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY) });
});

/**
 * GET /api/analyze?team1=PSG&team2=Arsenal
 * Renvoie une estimation basée sur les vraies données récentes des deux équipes.
 */
app.get("/api/analyze", async (req, res) => {
  const { team1, team2 } = req.query;

  if (!team1 || !team2) {
    return res.status(400).json({ error: "Paramètres team1 et team2 requis." });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: "Clé API non configurée côté serveur." });
  }

  try {
    const [t1, t2] = await Promise.all([findTeam(team1), findTeam(team2)]);

    if (!t1 || !t2) {
      return res.status(404).json({
        error: `Équipe introuvable : ${!t1 ? team1 : team2}. Vérifie l'orthographe.`,
      });
    }

    const [formHome, formAway, h2hCount] = await Promise.all([
      getRecentForm(t1.id, 7),
      getRecentForm(t2.id, 7),
      getHeadToHead(t1.id, t2.id, 5),
    ]);

    const estimate = computeEstimate(formHome, formAway, h2hCount);

    res.json({
      disclaimer:
        "Cette estimation est calculée à partir des résultats réels récents des deux équipes. Ce n'est pas une garantie de résultat futur.",
      teams: {
        home: { name: t1.name, logo: t1.logo },
        away: { name: t2.name, logo: t2.logo },
      },
      form: { home: formHome, away: formAway },
      headToHeadMatchesFound: h2hCount,
      estimate,
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(502).json({
      error: "Erreur lors de la récupération des données sportives. Réessaie dans un instant.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ VisiSport backend démarré sur le port ${PORT}`);
});
