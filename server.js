// server.js
import { createServer } from "node:http";
import next from "next";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import { MongoDB, MySQLDB } from "./utils/databaseJS.js";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 3000;
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();
const SECRET_KEY = "your-secret-key";

app.prepare().then(() => {
  const httpServer = createServer(handler);
  const io = new Server(httpServer);

  const channelClients = new Map();
  const clientDatabases = new Map();
  const onlineUsers = new Map();

  io.on("connection", (socket) => {
    console.log("Client connected: ", socket.id);

    socket.on("close", () => {
      //close the db connection
      clientDatabases.get(socket.id).close();
      clientDatabases.delete(socket.id);
    });

    socket.on("initialize", async ({ dbType, connectionInfo }) => {
      let db;
      if (dbType === "mongodb") {
        db = new MongoDB(connectionInfo);
      } else if (dbType === "mysql") {
        db = new MySQLDB(connectionInfo);
      } else {
        socket.emit("error", { message: "Unsupported database type" });
        return;
      }

      try {
        await db.connect(connectionInfo);
        if (!clientDatabases.has(socket.id)) {
          clientDatabases.set(socket.id, db);
          console.log(
            `Database initialized for client ${socket.id}: ${dbType}`
          );
        } else {
          console.log("Database already initialized for client", socket.id);
          db.close();
        }
      } catch (err) {
        console.error("Database connection error:", err);
        socket.emit("error", { message: "Failed to connect to database" });
      }
    });

    socket.on("listen", (channel) => {
      if (!channelClients[channel]) {
        channelClients[channel] = new Set();
      }
      channelClients[channel].add(socket.id);
      socket.join(channel);
    });

    socket.on("action", async (data) => {
      const { action, channel, code, method } = data;
      const db = clientDatabases.get(socket.id);
      if (!db) {
        socket.emit("error", { message: "Database not initialized" });
        return;
      }

      if (action === "execute" && code) {
        const rawResponse = await db.execute(code);

        let response;
        if (db instanceof MongoDB) {
          switch (method) {
            case "insert":
              response = {
                status: rawResponse.status,
                result: { insertedId: rawResponse.result.insertedId },
              };
              break;
            case "delete":
              response = {
                status: rawResponse.status,
                result: {
                  id: code.match(/_id: "([^"]+)"/)?.[1],
                  deletedCount: rawResponse.result.deletedCount,
                },
              };
              break;
            case "update":
              response = {
                status: rawResponse.status,
                result: {
                  updatedId: code.match(/_id: "([^"]+)"/)?.[1],
                  updatedDoc: rawResponse.result,
                },
              };
              break;
            case "get":
              response = rawResponse; // A teljes eredményt visszaadjuk
              break;
            default:
              response = rawResponse;
          }
        } else if (db instanceof MySQLDB) {
          switch (method) {
            case "insert":
              response = {
                status: rawResponse.status,
                result: { insertId: rawResponse.result.insertId },
              };
              break;
            case "delete":
              response = {
                status: rawResponse.status,
                result: { affectedRows: rawResponse.result.affectedRows },
              };
              break;
            case "update":
              response = {
                status: rawResponse.status,
                result: { affectedRows: rawResponse.result.affectedRows },
              };
              break;
            case "get":
              response = rawResponse; // A teljes eredményt visszaadjuk
              break;
            default:
              response = rawResponse;
          }
        }

        // A kliensnek és a csatornára feliratkozott összes kliensnek elküldjük a választ
        socket.emit(`${channel}:result`, response);
        if (channelClients[channel]) {
          channelClients[channel].forEach((clientId) => {
            io.to(clientId).emit(`${channel}`, response);
          });
        }
      }
    });

    socket.on("unsubscribe", (channel) => {
      if (channelClients[channel]) {
        channelClients[channel].delete(socket.id);
        if (channelClients[channel].size === 0) {
          delete channelClients[channel];
        }
      }
      socket.leave(channel);
    });

    socket.on("message", (data) => {
      const { channel, message } = data;
      channelClients[channel]?.forEach((clientId) => {
        io.to(clientId).emit(channel, { message });
      });
    });

    socket.on("subscribe", (channel) => {
      if (!channelClients[channel]) {
        channelClients[channel] = new Set();
      }
      channelClients[channel].add(socket.id);
      socket.join(channel);
    });

    socket.on("account:action", async (data) => {
      const { action, data: payload, token, session } = data;
      const db = clientDatabases.get(socket.id);
    
      if (!db) {
        console.error(`Database not initialized for socket ${socket.id}`);
        socket.emit("account:result", {
          status: "error",
          message: "Database not initialized for this client",
        });
        return;
      }
    
      try {
        switch (action) {
          case  "signup":
            try {
              const userId = await db.signUp(payload);
              if (!userId) throw new Error("Signup failed");
              const sessionId = Math.random().toString(16).slice(2);
              await db.setSession(userId, { sessionId });
              const signupToken = jwt.sign(
                { userId: userId.toString(), email: payload.email },
                SECRET_KEY,
                { expiresIn: "24h" }
              );
              socket.emit("account:result", {
                status: "success",
                token: signupToken,
                sessionId,
              });
              socket.emit("account", { event: "signup", userId });
            } catch (err) {
              socket.emit("account:result", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          case "signin":
            try {
              const user = await db.signIn(payload.email, payload.password);
              if (!user) throw new Error("User not found or invalid password");
              const sessionId = Math.random().toString(16).slice(2);
              await db.setSession(user._id, sessionId); // Store session with sessionId
              const signInToken = jwt.sign(
                { userId: user._id, email: user.email },
                SECRET_KEY,
                { expiresIn: "24h" }
              );
              socket.emit("account:result", {
                status: "success",
                token: signInToken,
                sessionId, // Return sessionId instead of session object
              });
              socket.emit("account", { event: "signin", userId: user._id });
            } catch (err) {
              socket.emit("account:result", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          case "getAccount":
            if (!token) throw new Error("No token provided");
            const decodedGetAccount = jwt.verify(token, SECRET_KEY);
            try {
              const account = await db.getAccount(decodedGetAccount.userId);
              socket.emit("account:get", { status: "success", data: account });
              if (!onlineUsers.has(decodedGetAccount.userId)) {
                onlineUsers.set(decodedGetAccount.userId, socket.id);
                const onlineUserIds = Array.from(onlineUsers.keys());
                const onlineUsersData = await db.getUsers(onlineUserIds);
                channelClients["users:onlineChanged"]?.forEach((clientId) => {
                  io.to(clientId).emit("users:onlineChanged", onlineUsersData);
                });
              }
              socket.emit("account:get", {
                event: "getAccount",
                userId: decodedGetAccount.userId,
              });
            } catch (err) {
              socket.emit("account:get", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          case "getSession":
            if (!token || !session) throw new Error("No token/session provided");
            jwt.verify(token, SECRET_KEY, async (err, decoded) => {
              if (err) {
                socket.emit("account:session", {
                  status: "error",
                  message: "Invalid or expired token",
                });
              } else {
                const sessionData = await db.getSession(decoded.userId, session);
                socket.emit("account:session", {
                  status: "success",
                  data: sessionData,
                });
                if (!onlineUsers.has(decoded.userId)) {
                  onlineUsers.set(decoded.userId, socket.id);
                  const onlineUserIds = Array.from(onlineUsers.keys());
                  const onlineUsersData = await db.getUsers(onlineUserIds);
                  channelClients["users:onlineChanged"]?.forEach((clientId) => {
                    io.to(clientId).emit("users:onlineChanged", onlineUsersData);
                  });
                }
              }
            });
            break;
    
          case "getSessions":
            if (!token) throw new Error("No token provided");
            jwt.verify(token, SECRET_KEY, async (err, decoded) => {
              if (err) {
                socket.emit("account:session", {
                  status: "error",
                  message: "Invalid or expired token",
                });
              } else {
                const sessions = await db.getSessions(decoded.userId);
                socket.emit("account:session", {
                  status: "success",
                  data: sessions,
                });
                if (!onlineUsers.has(decoded.userId)) {
                  onlineUsers.set(decoded.userId, socket.id);
                  const onlineUserIds = Array.from(onlineUsers.keys());
                  const onlineUsersData = await db.getUsers(onlineUserIds);
                  channelClients["users:onlineChanged"]?.forEach((clientId) => {
                    io.to(clientId).emit("users:onlineChanged", onlineUsersData);
                  });
                }
              }
            });
            break;
    
          case "setSession":
            if (!token) throw new Error("No token provided");
            const user = jwt.verify(token, SECRET_KEY);
            try {
              await db.setSession(user.userId, session);
              socket.emit("account:result", {
                status: "success",
                message: "Session set",
              });
            } catch (err) {
              socket.emit("account:result", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          case "killSession":
            if (!token || !session) throw new Error("No token/session provided");
            const killData = jwt.verify(token, SECRET_KEY);
            try {
              await db.killSession( session);
              socket.emit("account:result", {
                status: "success",
                message: "Session killed",
              });
              if (onlineUsers.has(killData.userId)) {
                onlineUsers.delete(killData.userId);
                const onlineUserIds = Array.from(onlineUsers.keys());
                const onlineUsersData = await db.getUsers(onlineUserIds);
                channelClients["users:onlineChanged"]?.forEach((clientId) => {
                  io.to(clientId).emit("users:onlineChanged", onlineUsersData);
                });
              }
              channelClients["account"]?.forEach((clientId) => {
                io.to(clientId).emit("account", {
                  event: "sessionKilled",
                  userId: killData.userId,
                });
              });
            } catch (err) {
              socket.emit("account:result", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          case "killSessions":
            if (!token) throw new Error("No token provided"); // Adjusted to not require session
            const jwtData = jwt.verify(token, SECRET_KEY);
            try {
              await db.killSessions(jwtData.userId); // Assuming killSessions exists
              socket.emit("account:result", {
                status: "success",
                message: "Sessions killed",
              });
              if (onlineUsers.has(jwtData.userId)) {
                onlineUsers.delete(jwtData.userId);
                const onlineUserIds = Array.from(onlineUsers.keys());
                const onlineUsersData = await db.getUsers(onlineUserIds);
                channelClients["users:onlineChanged"]?.forEach((clientId) => {
                  io.to(clientId).emit("users:onlineChanged", onlineUsersData);
                });
              }
              channelClients["account"]?.forEach((clientId) => {
                io.to(clientId).emit("account", {
                  event: "sessionKilled",
                  userId: jwtData.userId,
                });
              });
            } catch (err) {
              socket.emit("account:result", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          case "changeSession":
            if (!token || !session) throw new Error("No token/session provided");
            if(!jwt.verify(token, SECRET_KEY)) throw new Error("Invalid token");
            try {
              await db.changeSession(session, payload);
              socket.emit("account:result", {
                status: "success",
                message: "Session changed",
              });
            } catch (err) {
              socket.emit("account:result", {
                status: "error",
                message: err.message,
              });
            }
            break;
    
          default:
            socket.emit("account:result", {
              status: "error",
              message: "Unknown action",
            });
        }
      } catch (err) {
        console.error("Account action error:", err.message);
        socket.emit("account:result", {
          status: "error",
          message: err.message || "Unexpected error",
        });
      }
    });

    // USERS SCOPE
    socket.on("users:action", async (data) => {
      const { action, token, userId, userIds } = data;
      const db = clientDatabases.get(socket.id);

      if (!db) {
        socket.emit("users:result", {
          status: "error",
          message: "Database not initialized",
        });
        return;
      }

      if (!token) {
        socket.emit("users:result", {
          status: "error",
          message: "No token provided",
        });
        return;
      }

      try {
        const decoded = jwt.verify(token, SECRET_KEY);

        switch (action) {
          case "listAll":
            const listAllQuery = `collection('users').find().toArray()`;
            const allUsersResult = await db.execute(listAllQuery);
            const allUsers = allUsersResult.result.map((user) => ({
              _id: user._id.toString(),
              email: user.email,
              createdAt: user.createdAt,
            }));
            socket.emit("users:result", { status: "success", data: allUsers });
            break;

          case "listOnline":
            const onlineUserIds = Array.from(onlineUsers.keys());
            const onlineUsersData = await db.getUsers(onlineUserIds);
            console.log("Online users:", onlineUsersData, onlineUsersResult);
            socket.emit("users:online", {
              status: "success",
              data: onlineUsersData,
            });
            break;

          case "getUser":
            if (!userId) throw new Error("No userId provided");
            try {
              const user = await db.getUser(userId);
              socket.emit("users:result", { status: "success", data: user });
              
            }
            catch (err) {
              socket.emit("users:get-user", { status: "error", message: err.message });
            }
            break

          case "getUsers":
            if (!userIds) throw new Error("No userIds provided");
            try {
              const users = await db.getUsers(userIds);
              socket.emit("users:result", { status: "success", data: users });
            }
            catch (err) {
              socket.emit("users:get-users", { status: "error", message: err.message });
            }
            break;
          default:
            socket.emit("users:result", {
              status: "error",
              message: "Unknown action",
            });
        }
      } catch (err) {
        console.error("Users action error:", err.message);
        socket.emit("users:result", { status: "error", message: err.message });
      }
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected: ", socket.id);
      clientDatabases.get(socket.id)?.close();
      clientDatabases.delete(socket.id);
      for (const [userId, socketId] of onlineUsers) {
        if (socketId === socket.id) {
          onlineUsers.delete(userId);
          io.emit("users:onlineChanged", Array.from(onlineUsers.keys()));
          break;
        }
      }
      for (const channel in channelClients) {
        channelClients[channel].delete(socket.id);
        if (channelClients[channel].size === 0) {
          delete channelClients[channel];
        }
      }
    });
  });

  httpServer.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
