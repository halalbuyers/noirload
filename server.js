const express = require('express');
const { spawn, spawnSync } = require('child_process');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/\.+$/, '') || `download_${Date.now()}`;
}

function findPythonCommand() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3', 'python'];
  const checker = process.platform === 'win32' ? 'where' : 'which';

  for (const cmd of candidates) {
    const result = spawnSync(checker, [cmd], { stdio: 'ignore' });
    if (result.status === 0) return cmd;
  }

  throw new Error('Python executable not found. Install Python and add it to PATH.');
}

function checkYtDlpAvailable(pythonCmd) {
  const result = spawnSync(pythonCmd, ['-m', 'yt_dlp', '--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.stdout || (result.error && result.error.message) || 'Unknown error';
    throw new Error(`yt-dlp is not available: ${message}`);
  }
}

const PYTHON_CMD = findPythonCommand();
checkYtDlpAvailable(PYTHON_CMD);
console.log(`Using Python command: ${PYTHON_CMD}`);
let progressData = { progress: 0, speed: '', size: '', latestLog: '', currentTask: '' };

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

// Get available quality formats and metadata
app.post('/api/formats', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const args = ['-m', 'yt_dlp', '-j', url];
  const yt = spawn(PYTHON_CMD, args);

  let output = '';
  let errorOutput = '';
  yt.stdout.on('data', (data) => output += data.toString());
  yt.stderr.on('data', (data) => errorOutput += data.toString());

  yt.on('error', (err) => {
    console.error('[yt-dlp ERROR] spawn failed', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to run yt-dlp', details: err.message });
    }
  });

  yt.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0) {
      console.error('[yt-dlp ERROR]', errorOutput.trim());
      return res.status(500).json({ error: 'Failed to fetch metadata', details: errorOutput.trim() });
    }

    let meta;
    try {
      meta = JSON.parse(output);
    } catch (err) {
      console.error('[yt-dlp ERROR] invalid metadata JSON', err);
      return res.status(500).json({ error: 'Invalid yt-dlp response' });
    }

    const formats = Array.isArray(meta.formats) ? meta.formats : [];
    const videoQualities = [];
    const audioFormats = [];
    const formatDetails = [];
    const seen = new Set();

    formats.forEach((fmt) => {
      const { format_id, ext, vcodec, acodec, height, fps, filesize, format_note, resolution, abr, tbr } = fmt;
      const label = height ? `${height}p` : resolution || format_id;
      const noteParts = [];
      if (vcodec && vcodec !== 'none') noteParts.push(vcodec);
      if (acodec && acodec !== 'none') noteParts.push(acodec);
      if (format_note) noteParts.push(format_note);
      const note = noteParts.join(' | ');

      formatDetails.push({
        format_id,
        ext,
        resolution: label,
        height: height || 0,
        fps: fps || 0,
        filesize: filesize || 0,
        note,
        format: fmt.format,
      });

      if (vcodec && vcodec !== 'none') {
        const qualityKey = `${height || 0}_${ext}`;
        if (!seen.has(qualityKey)) {
          seen.add(qualityKey);
          videoQualities.push({
            value: height ? String(height) : 'best',
            label: `${label} · ${ext} · ${note}`,
            height: height || 0,
          });
        }
      }

      if (acodec && acodec !== 'none') {
        audioFormats.push({
          value: format_id,
          label: `${format_id} · ${ext} · ${note}`,
          abr: abr || tbr || 0,
        });
      }
    });

    videoQualities.sort((a, b) => b.height - a.height);
    audioFormats.sort((a, b) => b.abr - a.abr);

    const subtitles = meta.subtitles ? Object.keys(meta.subtitles) : [];
    const automaticCaptions = meta.automatic_captions ? Object.keys(meta.automatic_captions) : [];

    res.json({
      title: meta.title || '',
      uploader: meta.uploader || '',
      duration: meta.duration || 0,
      videoQualities,
      audioFormats,
      formatDetails,
      subtitles,
      automaticCaptions,
    });
  });
});

async function createZipArchive(files, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));
    archive.pipe(output);

    files.forEach((filePath) => {
      archive.file(filePath, { name: path.basename(filePath) });
    });

    archive.finalize();
  });
}

function cleanupFiles(paths) {
  paths.forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
  });
}

// Main download endpoint
app.post('/api/download', async (req, res) => {
  const {
    url,
    format,
    quality,
    customName = '',
    subtitleMode = 'none',
    subtitleLang = 'en',
    embedMetadata = false,
    metadataTitle = '',
    metadataArtist = '',
    metadataAlbum = '',
  } = req.body;

  if (!url) {
    return res.status(400).send('URL is required');
  }

  const isAudio = format === 'mp3';
  const safeName = sanitizeFilename(customName || `${format}_${Date.now()}`);
  const outputTemplate = path.join(DOWNLOAD_DIR, `${safeName}.%(ext)s`).replace(/\\/g, '/');

  progressData = {
    progress: 0,
    speed: '',
    size: '',
    latestLog: 'Preparing download...',
    currentTask: safeName,
  };

  const metadataArgs = [];
  if (metadataTitle) metadataArgs.push(`-metadata title=${JSON.stringify(metadataTitle)}`);
  if (metadataArtist) metadataArgs.push(`-metadata artist=${JSON.stringify(metadataArtist)}`);
  if (metadataAlbum) metadataArgs.push(`-metadata album=${JSON.stringify(metadataAlbum)}`);

  let args = ['-m', 'yt_dlp'];
  if (isAudio) {
    const audioFormat = quality && quality !== 'best' ? quality : 'bestaudio';
    args.push('-f', audioFormat, '-x', '--audio-format', 'mp3', '-o', outputTemplate);
  } else {
    const formatString = quality === 'best' ? 'bestvideo+bestaudio/best' : `bestvideo[height<=${quality}]+bestaudio/best`;
    args.push(
      '-f', formatString,
      '-o', outputTemplate,
      '--merge-output-format', 'mp4'
    );
  }

  if (embedMetadata || metadataArgs.length > 0) {
    args.push('--add-metadata');
  }

  const postprocessorArgs = [];
  if (!isAudio) {
    // Always transcode video audio to AAC for MP4 compatibility with most media players.
    postprocessorArgs.push('ffmpeg:-c:a aac -b:a 192k');
  } else if (embedMetadata || metadataArgs.length > 0) {
    postprocessorArgs.push('ffmpeg:-c:a libmp3lame -b:a 192k');
  }

  if (metadataArgs.length > 0) {
    postprocessorArgs.push(...metadataArgs.map(arg => `ffmpeg:${arg}`));
  }

  if (postprocessorArgs.length > 0) {
    args.push('--postprocessor-args', postprocessorArgs.join(' '));
  }

  if (subtitleMode === 'manual') {
    args.push('--write-sub', '--sub-lang', subtitleLang, '--convert-subs', 'srt');
  } else if (subtitleMode === 'auto') {
    args.push('--write-auto-sub', '--sub-lang', subtitleLang, '--convert-subs', 'srt');
  }

  args.push('--newline', url);

  const ytdlp = spawn(PYTHON_CMD, args);
  let downloadError = '';

  ytdlp.on('error', (err) => {
    console.error('[yt-dlp ERROR] spawn failed', err);
    downloadError += err.message;
    if (!res.headersSent) {
      res.status(500).send('Failed to start yt-dlp: ' + err.message);
    }
  });

  ytdlp.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (!line.trim()) return;
      progressData.latestLog = line.trim();
      console.log('[yt-dlp]', line.trim());
      const percentMatch = line.match(/(\d{1,3}\.\d)% of/);
      const sizeMatch = line.match(/of\s+([\d\.]+[MKG]iB)/);
      const speedMatch = line.match(/at\s+([\d\.]+[KMG]iB\/s)/);

      if (percentMatch) progressData.progress = parseFloat(percentMatch[1]);
      if (sizeMatch) progressData.size = sizeMatch[1];
      if (speedMatch) progressData.speed = speedMatch[1];
    });
  });

  ytdlp.stderr.on('data', (data) => {
    const message = data.toString();
    downloadError += message;
    progressData.latestLog = message.trim();
    console.error('[yt-dlp ERROR]', message.trim());
  });

  ytdlp.on('close', async (code) => {
    if (res.headersSent) return;

    if (code !== 0) {
      const errorMessage = downloadError.trim() || `yt-dlp exited with code ${code}`;
      return res.status(500).send(`Download failed: ${errorMessage}`);
    }

    const candidates = fs.readdirSync(DOWNLOAD_DIR).filter((name) =>
      name.startsWith(`${safeName}.`) && !name.endsWith('.part') && !name.endsWith('.tmp')
    );
    const subtitleCandidates = candidates.filter((name) => name.endsWith('.srt'));
    const exactTarget = `${safeName}.${isAudio ? 'mp3' : 'mp4'}`;
    const exactTargetPath = path.join(DOWNLOAD_DIR, exactTarget);

    let finalFile = fs.existsSync(exactTargetPath) ? exactTargetPath : null;
    if (!finalFile) {
      const fileCandidates = candidates.filter((name) => /\.(mp4|mp3|webm|m4a)$/i.test(name));
      const filteredCandidates = fileCandidates.filter((name) => !/\.f\d+\./i.test(name));
      finalFile = filteredCandidates.length ? path.join(DOWNLOAD_DIR, filteredCandidates[0]) : (fileCandidates.length ? path.join(DOWNLOAD_DIR, fileCandidates[0]) : null);
    }

    if (!finalFile || !fs.existsSync(finalFile)) {
      return res.status(500).send('Download failed. File not found.');
    }

    const responseFilePath = finalFile;
    const cleanupTargets = [finalFile, ...subtitleCandidates.map((name) => path.join(DOWNLOAD_DIR, name))];

    const intermediateCandidates = candidates
      .filter((name) => name !== path.basename(finalFile) && !subtitleCandidates.includes(name))
      .map((name) => path.join(DOWNLOAD_DIR, name));
    cleanupTargets.push(...intermediateCandidates);

    const fileStream = fs.createReadStream(responseFilePath);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(responseFilePath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    fileStream.pipe(res);
    fileStream.on('close', () => cleanupFiles(cleanupTargets));
    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).send('Error sending file');
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ NoirLoad running at http://localhost:${PORT}`);
});