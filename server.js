const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 120000, // 2 minutes au lieu de 20 secondes
  pingInterval: 30000, // 30 secondes entre les pings
  connectTimeout: 60000, // 1 minute pour établir la connexion initiale
  maxHttpBufferSize: 5e6, // 5MB pour les messages audio
});

const PORT = process.env.PORT || 3838;
const ADMIN_CHANNEL_ID = "admin-persistent-channel-42a1b3c4"; // ID fixe pour le canal admin

// Stockage en mémoire des salons
const chatRooms = {};

console.log("Serveur Chat démarré.");

// Si le fichier n'existe pas, le créer avec des identifiants par défaut
const AUTH_CONFIG_PATH = path.join(__dirname, "admin-users.json");

function initAdminUsersConfig() {
  if (!fs.existsSync(AUTH_CONFIG_PATH)) {
    // Créer la configuration par défaut avec 2 utilisateurs
    // Utiliser bcrypt pour hasher les mots de passe
    const defaultConfig = {
      users: [
        {
          id: "admin1",
          username: "admin1",
          passwordHash: bcrypt.hashSync("mdpchange1", 10), // À remplacer
          displayName: "Administrateur 1",
        },
        {
          id: "admin2",
          username: "admin2",
          passwordHash: bcrypt.hashSync("mdpchange2", 10), // À remplacer
          displayName: "Administrateur 2",
        },
      ],
    };

    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log(
      "Configuration des utilisateurs administrateurs créée avec les paramètres par défaut"
    );
    console.log("IMPORTANT: Veuillez modifier les mots de passe par défaut!");
  }

  return JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf8"));
}

// Initialiser la configuration
const adminConfig = initAdminUsersConfig();

// ==========================================
// ROUTE SPÉCIFIQUE POUR LA RACINE '/' - DOIT VENIR AVANT express.static
// ==========================================

app.get("/", (req, res) => {
  const newRoomId = uuidv4();
  console.log(`Génération page d'accueil avec lien vers /chat/${newRoomId}`);
  res.send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <title>Générer Lien Chat</title>
            <style> body { font-family: sans-serif; margin: 20px; } code { background-color: #eee; padding: 3px; border-radius: 3px;} a { color: #007bff; text-decoration: none; } a:hover { text-decoration: underline; } </style>
        </head>
        <body>
            <h1>Générer un lien de Chat Privé</h1>
            <p>Partagez ce lien unique et secret avec la personne avec qui vous voulez discuter :</p>
            <p>
                <a href="/chat/${newRoomId}" target="_blank">https://privatechatter.artkabis.fr/chat/${newRoomId}</a>
                <br>
                <small><code>(ID Salon: ${newRoomId})</code></small>
            </p>
            <hr>
            <p><strong>Important :</strong> Ce lien est l'accès à votre conversation privée. Ne le partagez qu'avec la personne concernée.</p>
            <p>Ouvrez ce lien dans deux navigateurs différents (ou onglets de navigation privée) pour tester.</p>
        </body>
        </html>
    `);
});
// ==========================================
// FIN ROUTE POUR '/'
// ==========================================

// ==========================================
// SERVIR LES FICHIERS STATIQUES (CSS, JS Client, Images...)
// ==========================================
// Doit venir APRÈS les routes spécifiques comme '/' si elles ne doivent pas être interceptées.
// Ceci permet de servir style.css et client.js depuis le dossier public.
app.use(express.static(path.join(__dirname, "public"))); // ==========================================
// FIN FICHIERS STATIQUES
// ==========================================

// ==========================================
// ROUTE POUR LA PAGE DE CHAT '/chat/:roomId'
// ==========================================
// Vient APRÈS express.static car on veut que le fichier index.html soit servi,
// et que les requêtes ultérieures pour les fichiers DANS index.html (css, js)
// soient gérées par express.static.
app.get("/chat/:roomId", (req, res) => {
  const roomId = req.params.roomId;
  // La validation UUID est toujours importante ici
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      roomId
    )
  ) {
    console.warn(
      `Accès à /chat/ avec format invalide ou fichier non trouvé: ${roomId}`
    );
    // Renvoyer 404 si ce n'est pas un UUID et n'a pas été servi par static
    return res.status(404).send("Salon non trouvé ou ID invalide.");
  }
  // Si c'est un UUID valide, servir le HTML de l'application de chat
  console.log(`Service de public/index.html pour /chat/${roomId}`);
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// ==========================================
// FIN ROUTE POUR '/chat/:roomId'
// ==========================================

// 4. Ajouter des middlewares Express pour l'authentification
// Route de login pour les administrateurs
app.use(express.json()); // Pour parser le JSON

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({
        success: false,
        message: "Nom d'utilisateur et mot de passe requis",
      });
  }

  // Trouver l'utilisateur dans la configuration
  const user = adminConfig.users.find((u) => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res
      .status(401)
      .json({ success: false, message: "Identifiants invalides" });
  }

  // Générer un token simple (dans un vrai système, utilisez JWT)
  const token = Buffer.from(
    `${user.id}:${Date.now()}:${user.username}`
  ).toString("base64");

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    },
  });
});

// 5. Route pour le canal administrateur
app.get("/admin-channel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-channel.html"));
});

// 6. Middleware pour vérifier si l'utilisateur est autorisé à rejoindre le canal admin
function validateAdminUser(token) {
  if (!token) return null;

  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const [userId] = decoded.split(":");

    // Vérifier si l'ID utilisateur existe dans la configuration
    const user = adminConfig.users.find((u) => u.id === userId);
    return user || null;
  } catch (error) {
    console.error("Erreur lors de la validation du token:", error);
    return null;
  }
}

// ==========================================
// LOGIQUE SOCKET.IO
// ==========================================
io.on("connection", (socket) => {
  console.log(`Un utilisateur s'est connecté: ${socket.id}`);
  let currentRoomId = null;

  socket.on("joinRoom", async ({ roomId, name, publicKey }) => {
    // Validation rigoureuse des entrées
    if (
      !roomId ||
      typeof roomId !== "string" ||
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        roomId
      )
    ) {
      console.error(
        `Tentative de join avec roomId invalide: ${roomId} par ${socket.id}`
      );
      socket.emit("errorJoining", { message: "ID de salon invalide fourni." });
      return;
    }
    if (
      !name ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      name.trim().length > 50
    ) {
      console.error(
        `Tentative de join avec nom invalide: "${name}" par ${socket.id}`
      );
      socket.emit("errorJoining", { message: "Nom invalide ou trop long." });
      return;
    }
    if (!publicKey || typeof publicKey !== "object" || !publicKey.kty) {
      // Vérification basique JWK
      console.error(
        `Tentative de join sans clé publique ou format invalide par ${name} (${socket.id})`
      );
      socket.emit("errorJoining", {
        message: "Clé publique manquante ou invalide.",
      });
      return;
    }

    const cleanName = name.trim();
    console.log(`[${roomId}] ${cleanName} (${socket.id}) demande à rejoindre.`);
    currentRoomId = roomId;

    try {
      if (!chatRooms[roomId]) {
        // Création du salon
        chatRooms[roomId] = {
          participants: new Map(),
          initiatorId: socket.id,
          pendingValidation: undefined,
        };
        chatRooms[roomId].participants.set(socket.id, {
          name: cleanName,
          publicKey,
        });
        socket.join(roomId);
        console.log(
          `[${roomId}] Salon créé par ${cleanName} (${socket.id}). Attente du second participant.`
        );
        socket.emit("waitingForPeer");
      } else {
        // Le salon existe déjà
        const room = chatRooms[roomId];

        if (room.participants.has(socket.id)) {
          console.warn(
            `[${roomId}] ${cleanName} (${socket.id}) essaie de rejoindre alors qu'il est déjà dans le salon.`
          );
          return;
        }
        if (room.pendingValidation) {
          console.warn(
            `[${roomId}] Tentative de join par ${cleanName} alors que ${room.pendingValidation.name} est déjà en attente.`
          );
          socket.emit("errorJoining", {
            message: "Quelqu'un d'autre est déjà en attente de validation.",
          });
          return;
        }
        if (room.participants.size >= 2) {
          console.warn(
            `[${roomId}] Salon plein (limite 2), tentative par ${cleanName} (${socket.id}) refusée.`
          );
          socket.emit("roomFull");
          return;
        }

        const initiatorSocketId = room.initiatorId;
        if (!initiatorSocketId || !io.sockets.sockets.get(initiatorSocketId)) {
          console.error(
            `[${roomId}] Initiateur introuvable ou déconnecté pour validation par ${cleanName}.`
          );
          socket.emit("errorJoining", {
            message: "L'hôte de la discussion n'est plus disponible.",
          });
          if (!room.initiatorId && room.participants.size === 0)
            delete chatRooms[roomId];
          return;
        }

        room.pendingValidation = { id: socket.id, name: cleanName, publicKey };
        const initiatorSocket = io.sockets.sockets.get(initiatorSocketId);
        console.log(
          `[${roomId}] Envoi demande validation de ${cleanName} à l'initiateur ${initiatorSocketId}`
        );
        initiatorSocket.emit("validationRequest", {
          joiningUser: room.pendingValidation,
        });
        socket.emit("waitingForValidation");
      }
    } catch (error) {
      console.error(
        `[${roomId}] Erreur serveur critique lors du traitement de joinRoom pour ${socket.id}:`,
        error
      );
      socket.emit("errorJoining", { message: "Erreur interne du serveur." });
      if (
        chatRooms[roomId] &&
        chatRooms[roomId].participants.size === 0 &&
        !chatRooms[roomId].pendingValidation
      ) {
        delete chatRooms[roomId];
      }
    }
  });

  socket.on("acceptUser", async ({ joiningUserId, initiatorPublicKey }) => {
    if (!currentRoomId || !chatRooms[currentRoomId]) {
      console.error(
        `Impossible de trouver le salon ${currentRoomId} pour l'initiateur ${socket.id} lors de acceptUser.`
      );
      socket.emit("operationFailed", {
        message: "Erreur interne : salon introuvable.",
      });
      return;
    }
    const roomId = currentRoomId;
    const room = chatRooms[roomId];

    if (room.initiatorId !== socket.id) {
      console.warn(
        `[${roomId}] Tentative d'acceptation par ${socket.id} (non initiateur).`
      );
      socket.emit("operationFailed", { message: "Action non autorisée." });
      return;
    }
    if (
      !room.pendingValidation ||
      room.pendingValidation.id !== joiningUserId
    ) {
      console.warn(
        `[${roomId}] Tentative d'acceptation d'un utilisateur (${joiningUserId}) non en attente ou invalide.`
      );
      socket.emit("operationFailed", {
        message: "L'utilisateur demandé n'est plus en attente.",
      });
      return;
    }
    if (
      !initiatorPublicKey ||
      typeof initiatorPublicKey !== "object" ||
      !initiatorPublicKey.kty
    ) {
      console.error(
        `[${roomId}] Clé publique de l'initiateur manquante/invalide lors de l'acceptation.`
      );
      socket.emit("operationFailed", {
        message: "Erreur interne : clé initiateur invalide.",
      });
      return;
    }

    const joiningUserInfo = room.pendingValidation;
    const joiningSocket = io.sockets.sockets.get(joiningUserId);
    const initiatorInfo = room.participants.get(socket.id);

    if (joiningSocket && initiatorInfo) {
      try {
        console.log(
          `[${roomId}] ${initiatorInfo.name} (${socket.id}) a accepté ${joiningUserInfo.name} (${joiningUserId}).`
        );
        joiningSocket.join(roomId);
        room.participants.set(joiningUserId, {
          name: joiningUserInfo.name,
          publicKey: joiningUserInfo.publicKey,
        });
        delete room.pendingValidation;

        joiningSocket.emit("joinAccepted", {
          initiatorId: socket.id,
          initiatorName: initiatorInfo.name,
          initiatorPublicKey: initiatorPublicKey,
          participants: Array.from(room.participants.entries()).map(
            ([id, data]) => ({ id, name: data.name })
          ),
        });
        socket.emit("peerJoined", {
          peerId: joiningUserId,
          peerName: joiningUserInfo.name,
          peerPublicKey: joiningUserInfo.publicKey,
        });
        console.log(
          `[${roomId}] Utilisateurs connectés:`,
          Array.from(room.participants.keys())
        );
      } catch (error) {
        console.error(
          `[${roomId}] Erreur serveur lors de acceptUser pour ${joiningUserId}:`,
          error
        );
        socket.emit("operationFailed", {
          message: "Erreur interne lors de l'acceptation.",
        });
        if (joiningSocket)
          joiningSocket.emit("errorJoining", {
            message: "Erreur serveur lors de l'acceptation.",
          });
        if (room.participants.has(joiningUserId))
          room.participants.delete(joiningUserId);
        delete room.pendingValidation; // Nettoyer même en cas d'erreur
      }
    } else {
      console.warn(
        `[${roomId}] Utilisateur ${joiningUserId} à accepter (${
          joiningUserInfo?.name || "inconnu"
        }) s'est déconnecté ou problème.`
      );
      socket.emit("operationFailed", {
        message: `L'utilisateur ${
          joiningUserInfo?.name || "demandé"
        } n'est plus joignable.`,
      });
      delete room.pendingValidation;
    }
  });

  socket.on("rejectUser", ({ joiningUserId }) => {
    if (!currentRoomId || !chatRooms[currentRoomId]) {
      return;
    }
    const roomId = currentRoomId;
    const room = chatRooms[roomId];

    if (
      room.initiatorId !== socket.id ||
      !room.pendingValidation ||
      room.pendingValidation.id !== joiningUserId
    ) {
      console.warn(
        `[${roomId}] Tentative de refus invalide par ${socket.id} pour ${joiningUserId}.`
      );
      socket.emit("operationFailed", {
        message: "Impossible de refuser cet utilisateur.",
      });
      return;
    }

    const rejectedUserName = room.pendingValidation.name;
    console.log(
      `[${roomId}] ${
        room.participants.get(socket.id)?.name
      } a refusé ${rejectedUserName} (${joiningUserId}).`
    );
    const rejectedSocket = io.sockets.sockets.get(joiningUserId);
    if (rejectedSocket) {
      rejectedSocket.emit("joinRejected", {
        message:
          "Votre demande pour rejoindre le chat a été refusée par l'hôte.",
      });
    }
    delete room.pendingValidation;
    socket.emit("userRejected", { name: rejectedUserName });
  });

  socket.on("sendMessage", ({ encryptedMessage }) => {
    if (
      !currentRoomId ||
      !chatRooms[currentRoomId] ||
      !chatRooms[currentRoomId].participants.has(socket.id)
    ) {
      console.warn(
        `Message reçu de ${socket.id} qui n'est pas dans un salon enregistré (${currentRoomId}). Message ignoré.`
      );
      return;
    }
    if (!encryptedMessage) {
      console.warn(
        `[${currentRoomId}] Message vide reçu de ${socket.id}. Ignoré.`
      );
      return;
    }

    const room = chatRooms[currentRoomId];
    const senderInfo = room.participants.get(socket.id);

    if (senderInfo) {
      console.log(
        `[${currentRoomId}] Message chiffré reçu de ${senderInfo.name} (${socket.id}), relayé aux autres.`
      );
      socket.to(currentRoomId).emit("receiveMessage", {
        senderId: socket.id,
        senderName: senderInfo.name,
        encryptedMessage: encryptedMessage,
      });
    } else {
      console.error(
        `[${currentRoomId}] Incohérence: socket ${socket.id} a envoyé un message mais infos participant introuvables.`
      );
    }
  });

  socket.on("sendAudioChunk", (data) => {
    if (
      !currentRoomId ||
      !chatRooms[currentRoomId] ||
      !chatRooms[currentRoomId].participants.has(socket.id)
    ) {
      console.warn(
        `Morceau audio reçu de ${socket.id} qui n'est pas dans un salon enregistré (${currentRoomId}). Ignoré.`
      );
      return;
    }

    if (
      !data.encryptedAudio ||
      !data.encryptedKey ||
      !data.iv ||
      data.messageId === undefined ||
      data.chunkIndex === undefined ||
      data.totalChunks === undefined
    ) {
      console.warn(
        `[${currentRoomId}] Morceau audio incomplet reçu de ${socket.id}. Ignoré.`
      );
      return;
    }

    const room = chatRooms[currentRoomId];
    const senderInfo = room.participants.get(socket.id);

    if (senderInfo) {
      const chunkIndex = data.chunkIndex;
      const totalChunks = data.totalChunks;
      console.log(
        `[${currentRoomId}] Morceau audio ${
          chunkIndex + 1
        }/${totalChunks} reçu de ${senderInfo.name} (${socket.id}), relayé.`
      );

      socket.to(currentRoomId).emit("receiveAudioChunk", {
        senderId: socket.id,
        senderName: senderInfo.name,
        encryptedAudio: data.encryptedAudio,
        encryptedKey: data.encryptedKey,
        iv: data.iv,
        messageId: data.messageId,
        chunkIndex: data.chunkIndex,
        totalChunks: data.totalChunks,
      });
    } else {
      console.error(
        `[${currentRoomId}] Incohérence: socket ${socket.id} a envoyé un message audio mais infos participant introuvables.`
      );
    }
  });

  // Ajout du handler pour joinAdminChannel à l'intérieur du bloc io.on('connection')
  socket.on("joinAdminChannel", async ({ token, publicKey }) => {
    // Valider le token d'authentification
    const user = validateAdminUser(token);

    if (!user) {
      socket.emit("errorJoining", {
        message: "Authentification requise pour le canal administrateur",
      });
      return;
    }

    if (!publicKey || typeof publicKey !== "object" || !publicKey.kty) {
      socket.emit("errorJoining", {
        message: "Clé publique manquante ou invalide.",
      });
      return;
    }

    // Définir le canal actuel
    currentRoomId = ADMIN_CHANNEL_ID;

    try {
      // Créer le salon s'il n'existe pas
      if (!chatRooms[ADMIN_CHANNEL_ID]) {
        chatRooms[ADMIN_CHANNEL_ID] = {
          participants: new Map(),
          initiatorId: socket.id,
          pendingValidation: undefined,
          isPersistent: true, // Marquer ce salon comme persistant
          allowedUsers: adminConfig.users.map((u) => u.id), // Liste des utilisateurs autorisés
        };
      }

      const room = chatRooms[ADMIN_CHANNEL_ID];

      // Si l'utilisateur est déjà dans le salon, simplement mettre à jour sa connexion
      if (room.participants.has(socket.id)) {
        console.log(
          `[${ADMIN_CHANNEL_ID}] ${user.displayName} (${socket.id}) - reconnexion au canal administrateur`
        );
        // Mettre à jour la clé publique au cas où
        room.participants.set(socket.id, {
          name: user.displayName,
          userId: user.id,
          publicKey,
        });

        // Informer l'utilisateur qu'il est reconnecté
        socket.join(ADMIN_CHANNEL_ID);
        socket.emit("reconnectedToAdminChannel");

        // Informer les autres participants
        socket.to(ADMIN_CHANNEL_ID).emit("adminUserReconnected", {
          peerId: socket.id,
          peerName: user.displayName,
          peerPublicKey: publicKey,
        });

        return;
      }

      // Vérifier si le salon est plein (max 2 utilisateurs)
      if (room.participants.size >= 2) {
        // Vérifier si l'utilisateur fait partie des utilisateurs autorisés
        // et si un utilisateur déconnecté peut être remplacé
        let canReplace = false;
        let toReplaceId = null;

        for (const [
          participantId,
          participantData,
        ] of room.participants.entries()) {
          if (participantData.userId === user.id) {
            // Cet utilisateur était déjà connecté, on peut remplacer sa session
            canReplace = true;
            toReplaceId = participantId;
            break;
          }
        }

        if (canReplace && toReplaceId) {
          // Informer la précédente session qu'elle est déconnectée
          const previousSocket = io.sockets.sockets.get(toReplaceId);
          if (previousSocket) {
            previousSocket.emit("sessionReplaced", {
              message:
                "Votre session a été remplacée par une nouvelle connexion",
            });
            previousSocket.leave(ADMIN_CHANNEL_ID);
          }

          // Supprimer l'ancienne entrée
          room.participants.delete(toReplaceId);

          // Continuer avec la nouvelle connexion
          console.log(
            `[${ADMIN_CHANNEL_ID}] ${user.displayName} remplace sa session précédente`
          );
        } else {
          // Le salon est vraiment plein avec deux utilisateurs différents
          console.warn(
            `[${ADMIN_CHANNEL_ID}] Salon admin plein, connexion refusée pour ${user.displayName}`
          );
          socket.emit("adminChannelFull");
          return;
        }
      }

      // Ajouter l'utilisateur au salon
      room.participants.set(socket.id, {
        name: user.displayName,
        userId: user.id,
        publicKey,
      });

      socket.join(ADMIN_CHANNEL_ID);

      console.log(
        `[${ADMIN_CHANNEL_ID}] ${user.displayName} (${socket.id}) a rejoint le canal administrateur`
      );

      // Si c'est le premier utilisateur, l'informer qu'il est seul
      if (room.participants.size === 1) {
        socket.emit("waitingForPeerAdmin", { channelId: ADMIN_CHANNEL_ID });
        return;
      }

      // Si un autre administrateur est déjà connecté, établir la connexion
      const peers = [];
      for (const [peerId, peerData] of room.participants.entries()) {
        if (peerId !== socket.id) {
          peers.push({
            id: peerId,
            name: peerData.name,
            publicKey: peerData.publicKey,
          });

          // Informer l'autre pair de la connexion
          socket.to(peerId).emit("adminPeerJoined", {
            peerId: socket.id,
            peerName: user.displayName,
            peerPublicKey: publicKey,
          });
        }
      }

      // Informer le nouvel utilisateur des pairs existants
      socket.emit("adminChannelJoined", {
        channelId: ADMIN_CHANNEL_ID,
        peers,
      });
    } catch (error) {
      console.error(
        `[${ADMIN_CHANNEL_ID}] Erreur lors de la connexion au canal admin:`,
        error
      );
      socket.emit("errorJoining", { message: "Erreur interne du serveur." });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`Utilisateur déconnecté: ${socket.id}, raison: ${reason}`);
    let roomIdLeft = null;
    let wasParticipant = false;

    for (const roomId in chatRooms) {
      const room = chatRooms[roomId];

      if (room.pendingValidation && room.pendingValidation.id === socket.id) {
        const pendingName = room.pendingValidation.name;
        console.log(
          `[${roomId}] Utilisateur ${pendingName} (${socket.id}) déconnecté avant validation.`
        );
        const initiatorSocket = io.sockets.sockets.get(room.initiatorId);
        if (initiatorSocket) {
          initiatorSocket.emit("pendingUserDisconnected", {
            userId: socket.id,
            name: pendingName,
          });
        }
        delete room.pendingValidation;
        continue;
      }

      if (room.participants.has(socket.id)) {
        wasParticipant = true;
        roomIdLeft = roomId;
        const leavingUserInfo = room.participants.get(socket.id);
        const leavingUserName = leavingUserInfo?.name || "Utilisateur parti";
        const wasInitiator = room.initiatorId === socket.id;

        // Gestion spéciale pour les salons persistants
        if (room.isPersistent) {
          console.log(
            `[${roomId}] ${leavingUserName} (${socket.id}) s'est déconnecté du canal persistant`
          );

          // Informer les autres participants de la déconnexion
          socket.to(roomId).emit("adminPeerDisconnected", {
            userId: leavingUserInfo.userId,
            peerId: socket.id,
            peerName: leavingUserName,
            temporary: true, // Indique que la déconnexion est temporaire
          });

          // On ne supprime pas l'utilisateur du canal persistant
          // pour permettre une reconnexion ultérieure
          continue; // Passer à l'itération suivante sans supprimer le participant
        }

        // Pour les salons non persistants, comportement standard
        room.participants.delete(socket.id);
        console.log(
          `[${roomId}] ${leavingUserName} (${socket.id}) retiré du salon.`
        );

        if (room.participants.size > 0) {
          socket
            .to(roomId)
            .emit("userLeft", { userId: socket.id, name: leavingUserName });
          console.log(
            `[${roomId}] Notification de départ envoyée aux ${room.participants.size} restant(s).`
          );

          if (wasInitiator) {
            console.warn(
              `[${roomId}] L'initiateur ${leavingUserName} est parti.`
            );
            room.initiatorId = null;
            socket.to(roomId).emit("hostLeft");
            console.log(`[${roomId}] Notification 'hostLeft' envoyée.`);
          }
        } else {
          console.log(`[${roomId}] Salon vide après départ, suppression.`);
          delete chatRooms[roomId];
        }
        break;
      }
    }

    if (!wasParticipant && !roomIdLeft) {
      // console.log(`Déconnexion de ${socket.id} qui n'était dans aucun salon actif.`); // Moins utile à logger peut-être
    }
    currentRoomId = null;
  });
});
// ==========================================
// FIN LOGIQUE SOCKET.IO
// ==========================================

server.listen(PORT, () => {
  console.log(`Serveur écoutant sur http://localhost:${PORT}`);
  console.log(
    `Accédez à http://localhost:${PORT}/ pour générer un lien de chat.`
  );
});
