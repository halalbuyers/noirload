const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;
let progressData = { progress: 0, speed: '', size: '' };

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Real-time progress
app.get('/progress', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify(progressData)}\n\n`);
  }, 500);

  req.on('close', () => clearInterval(interval));
});

// Get available quality formats
app.post('/api/formats', (req, res) => {
  const { url } = req.body;

  const args = ["-m", "yt_dlp", "-F", url];
  const yt = spawn("python3", args);

  let output = '';
  yt.stdout.on('data', (data) => output += data.toString());

  yt.on('close', () => {
    const resolutions = [];
    output.split('\n').forEach(line => {
      const match = line.match(/\b(\d{3,4})p\b/);
      if (match && !resolutions.includes(match[1])) {
        resolutions.push(match[1]);
      }
    });

    res.json(resolutions.sort((a, b) => parseInt(a) - parseInt(b)));
  });

  yt.stderr.on('data', (data) => {
    console.error('[yt-dlp ERROR]', data.toString());
  });
});

// Main download endpoint
app.post('/api/download', (req, res) => {
  const { url, format, quality } = req.body;
  const timestamp = Date.now();
  const isAudio = format === 'mp3';
  const fileName = isAudio ? `audio_${timestamp}.mp3` : `video_${timestamp}.mp4`;
  const outputPath = path.join(__dirname, fileName);

  progressData = { progress: 0, speed: '', size: '' };

  let args;
  if (isAudio) {
    args = ['-m', 'yt_dlp', '-x', '--audio-format', 'mp3', '-o', fileName, url];
  } else {
    const formatString = (quality === 'best')
      ? 'bestvideo+bestaudio/best'
      : `bestvideo[height<=${quality}]+bestaudio/best`;
    args = ['-m', 'yt_dlp', '-f', formatString, '-o', fileName, '--newline', url];
  }

  const ytdlp = spawn('python3', args);

  ytdlp.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const percentMatch = line.match(/(\d{1,3}\.\d)% of/);
      const sizeMatch = line.match(/of\s+([\d\.]+[MKG]iB)/);
      const speedMatch = line.match(/at\s+([\d\.]+[KMG]iB\/s)/);

      if (percentMatch) progressData.progress = parseFloat(percentMatch[1]);
      if (sizeMatch) progressData.size = sizeMatch[1];
      if (speedMatch) progressData.speed = speedMatch[1];

      console.log("[yt-dlp]", line);
    }
  });

  ytdlp.stderr.on('data', (data) => {
    console.error("[yt-dlp ERROR]", data.toString());
  });

  ytdlp.on('close', () => {
    if (!fs.existsSync(outputPath)) {
      return res.status(500).send("Download failed. File not found.");
    }

    const fileStream = fs.createReadStream(outputPath);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    fileStream.pipe(res);
    fileStream.on('close', () => fs.unlink(outputPath, () => {}));
    fileStream.on('error', (err) => {
      console.error("File stream error:", err);
      res.status(500).send("Error sending file");
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ NoirLoad running at http://localhost:${PORT}`);
});
