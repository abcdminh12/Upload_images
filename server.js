// server.js
require("dotenv").config(); // Load biến môi trường khi chạy local
const express = require("express");
const multer = require("multer");
const { google } = require("googleapis");
const cors = require("cors");
const stream = require("stream");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// --- CẤU HÌNH TĨNH (Phục vụ file HTML) ---
// Bạn hãy tạo thư mục tên "public" và bỏ file index.html vào đó nhé
app.use(express.static(__dirname));

// --- [ADMIN CONFIG] LẤY TỪ ENV ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// --- CẤU HÌNH TÀI KHOẢN (SERVICE ACCOUNT TỪ ENV) ---
// Chúng ta sẽ lưu nội dung file JSON vào biến môi trường tên là GDRIVE_CREDENTIALS_1, v.v.
const DRIVE_ACCOUNTS = [
  {
    name: "Account 1 (Service Account)",
    // Lấy nội dung JSON từ biến môi trường
    credentialsEnv: "GDRIVE_CREDENTIALS_1",
    // Lấy Folder ID từ biến môi trường
    folderIdEnv: "FOLDER_ID_1",
  },
  {
    name: "Account 2 (Service Account)",
    credentialsEnv: "GDRIVE_CREDENTIALS_2",
    folderIdEnv: "FOLDER_ID_2",
  },
];

// Helper lấy Drive Client
const getDriveClient = (index = 0) => {
  const safeIndex = index >= 0 && index < DRIVE_ACCOUNTS.length ? index : 0;
  const acc = DRIVE_ACCOUNTS[safeIndex];

  // 1. Lấy Folder ID
  const folderId = process.env[acc.folderIdEnv];

  // 2. Lấy Credentials (JSON String) và Parse ra Object
  const credString = process.env[acc.credentialsEnv];

  if (!folderId || !credString) {
    throw new Error(`Chưa cấu hình biến môi trường cho ${acc.name}`);
  }

  let credentials;
  try {
    credentials = JSON.parse(credString);
  } catch (e) {
    throw new Error(
      `Lỗi format JSON trong biến môi trường ${acc.credentialsEnv}`
    );
  }

  // Khởi tạo Auth bằng Object credentials trực tiếp (Không cần file path)
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return {
    drive: google.drive({ version: "v3", auth: auth }),
    folderId: folderId,
    accName: acc.name,
  };
};

// --- ROUTE TRANG CHỦ (Để Render hiển thị giao diện) ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// --- CÁC API BÊN DƯỚI GIỮ NGUYÊN ---

app.get("/accounts", (req, res) => {
  const list = DRIVE_ACCOUNTS.map((acc, index) => ({ index, name: acc.name }));
  res.json({ success: true, accounts: list });
});

app.get("/files", async (req, res) => {
  try {
    const index = parseInt(req.query.index) || 0;
    const { drive, folderId, accName } = getDriveClient(index);
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "files(id, name, mimeType, thumbnailLink, webViewLink, webContentLink)",
      pageSize: 100,
      orderBy: "createdTime desc",
    });
    res.json({ success: true, server: accName, files: response.data.files });
  } catch (error) {
    console.error("Lỗi lấy danh sách file:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const index = parseInt(req.query.index) || 0;
    const { drive, folderId } = getDriveClient(index);
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id)",
      pageSize: 1000,
    });
    const count = listRes.data.files ? listRes.data.files.length : 0;
    const aboutRes = await drive.about.get({ fields: "storageQuota" });
    const quota = aboutRes.data.storageQuota;

    const limit = parseInt(quota.limit) || 0;
    const usage = parseInt(quota.usage) || 0;
    const totalGB = (limit / (1024 * 1024 * 1024)).toFixed(2);
    const usedGB = (usage / (1024 * 1024 * 1024)).toFixed(2);
    const percent = limit > 0 ? ((usage / limit) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      totalFiles: count,
      storage: { used: usedGB, total: totalGB, percent: percent },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/upload", upload.single("myFile"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No file" });
    const index = parseInt(req.body.accountIndex) || 0;
    const { drive, folderId, accName } = getDriveClient(index);

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const driveRes = await drive.files.create({
      requestBody: { name: req.file.originalname, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: bufferStream },
      fields: "id, name, webViewLink, thumbnailLink, mimeType",
    });

    await drive.permissions.create({
      fileId: driveRes.data.id,
      requestBody: { role: "reader", type: "anyone" },
    });

    res.json({
      success: true,
      data: {
        fileId: driveRes.data.id,
        name: driveRes.data.name,
        driveLink: driveRes.data.webViewLink,
        thumbnailLink: driveRes.data.thumbnailLink,
        server: accName,
        mimeType: driveRes.data.mimeType,
      },
    });
  } catch (err) {
    console.error("Lỗi Upload:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/upload-url", async (req, res) => {
  try {
    const { url, accountIndex } = req.body;
    if (!url)
      return res.status(400).json({ success: false, message: "Thiếu URL" });

    const index = parseInt(accountIndex) || 0;
    const { drive, folderId, accName } = getDriveClient(index);

    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
    });
    let filename = url.split("/").pop().split("?")[0];
    if (!filename || filename.length > 100)
      filename = `url_upload_${Date.now()}`;
    const mimeType =
      response.headers["content-type"] || "application/octet-stream";

    const driveResponse = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: mimeType, body: response.data },
      fields: "id, name, webViewLink, thumbnailLink, mimeType",
    });

    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: { role: "reader", type: "anyone" },
    });

    res.json({
      success: true,
      data: {
        fileId: driveResponse.data.id,
        name: driveResponse.data.name,
        driveLink: driveResponse.data.webViewLink,
        thumbnailLink: driveResponse.data.thumbnailLink,
        server: accName,
        mimeType: driveResponse.data.mimeType,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải từ URL: " + error.message });
  }
});

// --- ADMIN API ---
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  // So sánh với biến môi trường
  if (password === ADMIN_PASSWORD) res.json({ success: true });
  else
    res.status(401).json({ success: false, message: "Mật khẩu không đúng!" });
});

app.get("/admin/stats-all", async (req, res) => {
  const authPass = req.headers["x-admin-pass"];
  if (authPass !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false, message: "Unauthorized" });

  const allStats = [];
  for (let i = 0; i < DRIVE_ACCOUNTS.length; i++) {
    try {
      const { drive, accName } = getDriveClient(i);
      const aboutRes = await drive.about.get({ fields: "storageQuota" });
      const quota = aboutRes.data.storageQuota;
      const limit = parseInt(quota.limit) || 0;
      const usage = parseInt(quota.usage) || 0;
      allStats.push({
        name: accName,
        totalGB: (limit / (1024 * 1024 * 1024)).toFixed(2),
        usedGB: (usage / (1024 * 1024 * 1024)).toFixed(2),
        percent: limit > 0 ? ((usage / limit) * 100).toFixed(1) : 0,
      });
    } catch (e) {
      allStats.push({ name: DRIVE_ACCOUNTS[i].name, error: true });
    }
  }
  res.json({ success: true, servers: allStats });
});

app.get("/admin/files/:serverIndex", async (req, res) => {
  const authPass = req.headers["x-admin-pass"];
  if (authPass !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false, message: "Unauthorized" });

  try {
    const serverIndex = parseInt(req.params.serverIndex);
    const { drive, folderId } = getDriveClient(serverIndex);
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "files(id, name, size, md5Checksum, createdTime, webViewLink, mimeType)",
      pageSize: 1000,
      orderBy: "createdTime desc",
    });
    res.json({ success: true, files: response.data.files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete("/admin/files/:serverIndex/:fileId", async (req, res) => {
  const authPass = req.headers["x-admin-pass"];
  if (authPass !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false, message: "Unauthorized" });
  try {
    const serverIndex = parseInt(req.params.serverIndex);
    const { drive } = getDriveClient(serverIndex);
    await drive.files.delete({ fileId: req.params.fileId });
    res.json({ success: true, message: "Deleted" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/admin/empty-trash/:serverIndex", async (req, res) => {
  const authPass = req.headers["x-admin-pass"];
  if (authPass !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false });
  try {
    const { drive } = getDriveClient(parseInt(req.params.serverIndex));
    await drive.files.emptyTrash();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/admin/rename", async (req, res) => {
  const authPass = req.headers["x-admin-pass"];
  if (authPass !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false });
  try {
    const { drive } = getDriveClient(parseInt(req.body.accountIndex));
    await drive.files.update({
      fileId: req.body.fileId,
      requestBody: { name: req.body.newName },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Port cho Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`)
);
