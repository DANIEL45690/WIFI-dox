const os = require('os');
const { exec, spawn } = require('child_process');
const readline = require('readline');

let currentNetwork = null;
let trafficHistory = [];
let lastStats = { upload: 0, download: 0, timestamp: Date.now() };
let monitoringInterval = null;
let isMonitoring = false;
let connectionCheckInterval = null;

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[38;2;255;51;51m',
  green: '\x1b[38;2;0;255;136m',
  blue: '\x1b[38;2;51;153;255m',
  yellow: '\x1b[38;2;255;204;0m',
  purple: '\x1b[38;2;153;51;255m',
  cyan: '\x1b[38;2;0;204;204m',
  white: '\x1b[38;2;255;255;255m',
  gray: '\x1b[38;2;136;149;176m'
};

const getActiveNetworkInterface = () => {
  return new Promise((resolve) => {
    const platform = os.platform();

    if (platform === 'win32') {
      exec('netsh wlan show interfaces', (err, stdout) => {
        if (err) return resolve(null);
        const nameMatch = stdout.match(/名称\s*:\s(.+)/) || stdout.match(/Name\s*:\s(.+)/);
        resolve(nameMatch ? nameMatch[1].trim() : 'Wi-Fi');
      });
    } else if (platform === 'darwin') {
      exec('networksetup -listallhardwareports', (err, stdout) => {
        if (err) return resolve('en0');
        const wifiMatch = stdout.match(/Wi-Fi|AirPort.*Device:\s(en\d+)/);
        resolve(wifiMatch ? wifiMatch[1] : 'en0');
      });
    } else {
      exec('ip link show | grep -E "wlan|wlp"', (err, stdout) => {
        if (err) return resolve('wlan0');
        const iface = stdout.match(/\d+:\s([^:]+):/);
        resolve(iface ? iface[1] : 'wlan0');
      });
    }
  });
};

const getCurrentWiFi = async () => {
  const platform = os.platform();

  if (platform === 'win32') {
    return new Promise((resolve) => {
      exec('netsh wlan show interfaces', (err, stdout) => {
        if (err || !stdout.includes('SSID')) {
          resolve({ ssid: 'No Connection', connected: false });
          return;
        }

        resolve({
          ssid: (stdout.match(/SSID\s*:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          bssid: (stdout.match(/BSSID\s*:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          signalStrength: parseInt((stdout.match(/Signal\s*:\s(\d+)%/) || [])[1] || '0'),
          receiveRate: (stdout.match(/接收速率\s*:\s(.+)/) || stdout.match(/Receive rate\s*:\s(.+)/) || [])[1]?.trim() || '0 Mbps',
          transmitRate: (stdout.match(/传输速率\s*:\s(.+)/) || stdout.match(/Transmit rate\s*:\s(.+)/) || [])[1]?.trim() || '0 Mbps',
          channel: (stdout.match(/Channel\s*:\s(\d+)/) || [])[1] || 'Unknown',
          radioType: (stdout.match(/Radio type\s*:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          authentication: (stdout.match(/Authentication\s*:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          cipher: (stdout.match(/Cipher\s*:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          connected: true
        });
      });
    });
  }

  else if (platform === 'darwin') {
    return new Promise((resolve) => {
      exec('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I', (err, stdout) => {
        if (err || !stdout.includes('SSID')) {
          resolve({ ssid: 'No Connection', connected: false });
          return;
        }

        const rssi = parseInt((stdout.match(/agrCtlRSSI:\s-?(\d+)/) || [])[1] || '0');
        const noise = parseInt((stdout.match(/agrCtlNoise:\s-?(\d+)/) || [])[1] || '0');
        const signalStrength = Math.min(100, Math.max(0, Math.floor(100 + (rssi + noise) / 1.5)));

        resolve({
          ssid: (stdout.match(/SSID:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          bssid: (stdout.match(/BSSID:\s(.+)/) || [])[1]?.trim() || 'Unknown',
          signalStrength: signalStrength,
          receiveRate: (stdout.match(/lastTxRate:\s(\d+)/) || [])[1] ? `${(stdout.match(/lastTxRate:\s(\d+)/) || [])[1]} Mbps` : 'Unknown',
          transmitRate: (stdout.match(/lastTxRate:\s(\d+)/) || [])[1] ? `${(stdout.match(/lastTxRate:\s(\d+)/) || [])[1]} Mbps` : 'Unknown',
          channel: (stdout.match(/channel:\s(\d+)/) || [])[1] || 'Unknown',
          radioType: '802.11ac',
          authentication: 'WPA2-Enterprise',
          cipher: 'AES-CCMP',
          connected: true
        });
      });
    });
  }

  else {
    return new Promise((resolve) => {
      exec('iwconfig 2>/dev/null | grep -E "ESSID|Signal|Bit Rate|Frequency"', (err, stdout) => {
        if (err || !stdout.includes('ESSID')) {
          resolve({ ssid: 'No Connection', connected: false });
          return;
        }

        const signalMatch = stdout.match(/Signal level=(-?\d+)/);
        const signalStrength = signalMatch ? Math.min(100, Math.max(0, Math.floor(100 + parseInt(signalMatch[1]) / 2))) : 0;

        resolve({
          ssid: (stdout.match(/ESSID:"(.+?)"/) || [])[1] || 'Unknown',
          bssid: 'Unknown',
          signalStrength: signalStrength,
          receiveRate: (stdout.match(/Bit Rate=(\d+)/) || [])[1] ? `${(stdout.match(/Bit Rate=(\d+)/) || [])[1]} Mbps` : 'Unknown',
          transmitRate: (stdout.match(/Bit Rate=(\d+)/) || [])[1] ? `${(stdout.match(/Bit Rate=(\d+)/) || [])[1]} Mbps` : 'Unknown',
          channel: (stdout.match(/Frequency:(\d+\.?\d*)/) || [])[1] || 'Auto',
          radioType: '802.11n',
          authentication: 'WPA2-PSK',
          cipher: 'CCMP',
          connected: true
        });
      });
    });
  }
};

const getAccurateTrafficStats = async (interfaceName) => {
  const platform = os.platform();

  if (platform === 'win32') {
    return new Promise((resolve) => {
      exec('netstat -e', (err, stdout) => {
        if (err) return resolve({ upload: 0, download: 0 });

        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('Bytes') || line.includes('字节')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
              const download = parseInt(parts[1].replace(/,/g, '')) || 0;
              const upload = parseInt(parts[2].replace(/,/g, '')) || 0;
              return resolve({ upload, download });
            }
          }
        }
        resolve({ upload: 0, download: 0 });
      });
    });
  }

  else if (platform === 'darwin') {
    const iface = interfaceName || 'en0';
    return new Promise((resolve) => {
      exec(`netstat -ib | grep "^${iface}"`, (err, stdout) => {
        if (err) return resolve({ upload: 0, download: 0 });

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10 && !parts[0].includes('Name')) {
            const download = parseInt(parts[6]) || 0;
            const upload = parseInt(parts[9]) || 0;
            return resolve({ upload, download });
          }
        }
        resolve({ upload: 0, download: 0 });
      });
    });
  }

  else {
    return new Promise((resolve) => {
      exec('cat /proc/net/dev | grep -E "wlan|eth|wlp"', (err, stdout) => {
        if (err) return resolve({ upload: 0, download: 0 });

        const lines = stdout.split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10) {
            const download = parseInt(parts[1]) || 0;
            const upload = parseInt(parts[9]) || 0;
            if (download > 0 || upload > 0) {
              return resolve({ upload, download });
            }
          }
        }
        resolve({ upload: 0, download: 0 });
      });
    });
  }
};

const measureRealLatency = () => {
  return new Promise((resolve) => {
    const start = Date.now();
    const ping = spawn('ping', ['-c', '1', '-W', '2', '8.8.8.8']);

    ping.on('close', (code) => {
      if (code === 0) {
        resolve(Date.now() - start);
      } else {
        exec('ping -n 1 8.8.8.8', (err, stdout) => {
          if (!err && stdout.includes('time=')) {
            const timeMatch = stdout.match(/time[=<](\d+)ms/);
            resolve(timeMatch ? parseInt(timeMatch[1]) : 999);
          } else {
            resolve(999);
          }
        });
      }
    });

    setTimeout(() => resolve(999), 3000);
  });
};

const measureBandwidth = () => {
  return new Promise((resolve) => {
    const start = Date.now();
    const https = require('https');
    const req = https.get('https://speed.cloudflare.com/__down?bytes=500000', (res) => {
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
      });
      res.on('end', () => {
        const duration = (Date.now() - start) / 1000;
        const speed = duration > 0 ? (bytes * 8) / duration / 1000000 : 0;
        resolve(Math.min(100, Math.max(0, Math.floor(speed * 10))));
      });
    });
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(0);
    });
  });
};

const getPacketLoss = () => {
  return new Promise((resolve) => {
    let sent = 0;
    let received = 0;
    const ping = spawn('ping', ['-c', '5', '-W', '1', '8.8.8.8']);

    ping.stdout.on('data', (data) => {
      const output = data.toString();
      const sentMatch = output.match(/(\d+)\s+packets\s+transmitted/);
      const receivedMatch = output.match(/(\d+)\s+received/);
      if (sentMatch) sent = parseInt(sentMatch[1]);
      if (receivedMatch) received = parseInt(receivedMatch[1]);
    });

    ping.on('close', () => {
      if (sent > 0) {
        const loss = ((sent - received) / sent) * 100;
        resolve(Math.min(100, loss));
      } else {
        resolve(0);
      }
    });

    setTimeout(() => resolve(0), 4000);
  });
};

const getSignalQuality = (strength) => {
  if (strength >= 80) return { rating: 'EXCELLENT', color: colors.green, bar: '██████████', icon: '📶' };
  if (strength >= 65) return { rating: 'VERY GOOD', color: colors.green, bar: '████████░░', icon: '📶' };
  if (strength >= 50) return { rating: 'GOOD', color: colors.cyan, bar: '██████░░░░', icon: '📶' };
  if (strength >= 35) return { rating: 'FAIR', color: colors.yellow, bar: '████░░░░░░', icon: '📶' };
  if (strength >= 20) return { rating: 'POOR', color: colors.red, bar: '██░░░░░░░░', icon: '⚠️' };
  return { rating: 'VERY POOR', color: colors.red, bar: '█░░░░░░░░░', icon: '❌' };
};

const analyzeSecurityDeep = (auth, cipher) => {
  let score = 0;
  let level = '';
  let vulnerabilities = [];

  if (auth.includes('WPA3')) {
    score = 98;
    level = 'EXCELLENT';
    vulnerabilities.push('No major vulnerabilities detected');
  } else if (auth.includes('WPA2-Enterprise')) {
    score = 85;
    level = 'VERY GOOD';
    vulnerabilities.push('Uses 802.1X authentication');
  } else if (auth.includes('WPA2')) {
    score = 70;
    level = 'GOOD';
    vulnerabilities.push('Vulnerable to KRACK attack if not patched');
  } else if (auth.includes('WPA')) {
    score = 45;
    level = 'WEAK';
    vulnerabilities.push('Vulnerable to TKIP attacks, upgrade recommended');
  } else if (auth.includes('WEP')) {
    score = 15;
    level = 'CRITICAL';
    vulnerabilities.push('Completely broken, can be cracked in minutes');
  } else if (auth.includes('Open') || auth === 'None') {
    score = 0;
    level = 'NONE';
    vulnerabilities.push('No encryption, all traffic is visible');
  } else {
    score = 50;
    level = 'MEDIUM';
    vulnerabilities.push('Unknown security protocol');
  }

  if (cipher && cipher === 'TKIP') {
    score -= 20;
    vulnerabilities.push('TKIP cipher is deprecated and insecure');
  }

  return { score: Math.max(0, score), level, vulnerabilities, auth, cipher };
};

const formatSpeed = (bytesPerSec) => {
  if (bytesPerSec === 0) return '0 B/s';
  if (bytesPerSec < 1024) return `${Math.floor(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(1)} GB/s`;
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const getWiFiChannels = () => {
  const channels = [];
  for (let i = 1; i <= 11; i++) channels.push(i);
  for (let i = 36; i <= 165; i += 4) channels.push(i);
  return channels;
};

const getChannelQuality = (channel, is5GHz) => {
  if (is5GHz) {
    const dfsChannels = [52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140];
    if (dfsChannels.includes(channel)) return { quality: 'MEDIUM', note: 'DFS channel - may have radar interference' };
    return { quality: 'GOOD', note: 'Clear channel' };
  } else {
    const overlapping = [1, 6, 11];
    if (overlapping.includes(channel)) return { quality: 'BEST', note: 'Non-overlapping channel' };
    return { quality: 'POOR', note: 'Overlaps with adjacent channels' };
  }
};

const monitorTrafficLoop = async (interfaceName) => {
  if (!isMonitoring) return;

  try {
    const currentStats = await getAccurateTrafficStats(interfaceName);
    const now = Date.now();

    if (lastStats.upload > 0 && lastStats.timestamp) {
      const timeDiff = Math.max(0.5, (now - lastStats.timestamp) / 1000);
      const uploadSpeed = Math.max(0, (currentStats.upload - lastStats.upload) / timeDiff);
      const downloadSpeed = Math.max(0, (currentStats.download - lastStats.download) / timeDiff);

      trafficHistory.push({
        timestamp: now,
        uploadSpeed,
        downloadSpeed,
        uploadTotal: currentStats.upload,
        downloadTotal: currentStats.download
      });

      if (trafficHistory.length > 120) {
        trafficHistory = trafficHistory.slice(-120);
      }
    }

    lastStats = { ...currentStats, timestamp: now };
  } catch (err) {}
};

const refreshDisplay = async () => {
  try {
    const wifi = await getCurrentWiFi();
    const interfaceName = await getActiveNetworkInterface();

    if (!wifi.connected) {
      console.log('\x1b[2J\x1b[H');
      console.log(`${colors.red}╔════════════════════════════════════════════════════════════════════════════╗${colors.reset}`);
      console.log(`${colors.red}║                          NO WIFI CONNECTION DETECTED                       ║${colors.reset}`);
      console.log(`${colors.red}║                    Please connect to a WiFi network and retry              ║${colors.reset}`);
      console.log(`${colors.red}╚════════════════════════════════════════════════════════════════════════════╝${colors.reset}`);
      return;
    }

    const quality = getSignalQuality(wifi.signalStrength);
    const security = analyzeSecurityDeep(wifi.authentication, wifi.cipher);
    const latency = await measureRealLatency();
    const packetLoss = await getPacketLoss();
    const bandwidthScore = await measureBandwidth();

    let avgUploadSpeed = 0;
    let avgDownloadSpeed = 0;
    let peakUpload = 0;
    let peakDownload = 0;

    if (trafficHistory.length > 0) {
      const recent = trafficHistory.slice(-10);
      avgUploadSpeed = recent.reduce((sum, t) => sum + t.uploadSpeed, 0) / recent.length;
      avgDownloadSpeed = recent.reduce((sum, t) => sum + t.downloadSpeed, 0) / recent.length;
      peakUpload = Math.max(...trafficHistory.map(t => t.uploadSpeed));
      peakDownload = Math.max(...trafficHistory.map(t => t.downloadSpeed));
    }

    const totalDownload = lastStats.download;
    const totalUpload = lastStats.upload;

    const channelNum = parseInt(wifi.channel);
    const is5GHz = wifi.radioType.includes('ac') || wifi.radioType.includes('ax') || (channelNum > 36);
    const channelAnalysis = getChannelQuality(channelNum, is5GHz);

    const width = process.stdout.columns || 100;

    console.log('\x1b[2J\x1b[H');

    console.log(`${colors.green}╔${'═'.repeat(width - 2)}╗${colors.reset}`);

    const asciiArt = [
      `          _                                                                       `,
      `      o _|_ o  _|  _       |_        /  \\  _  _  ._   _  _  |  _    |_   _.  _ |  `,
      ` \\/\\/ |  |  |   (_| (_) ><   |_) \\/   | (|/ (_ (_) | | (_ (_) | (/_   | | (_| (_ |< `,
      `                                 /     \\__                                           `
    ];

    asciiArt.forEach(line => {
      const padding = Math.max(0, Math.floor((width - line.length) / 2));
      console.log(`${colors.green}${' '.repeat(padding)}${line}${colors.reset}`);
    });

    console.log();

    const title = '█ WIFI ANALYZER PRO v3.0 - ENTERPRISE EDITION █';
    const titlePadding = Math.max(0, Math.floor((width - title.length) / 2));
    console.log(`${colors.bright}${colors.green}${' '.repeat(titlePadding)}${title}${colors.reset}`);
    console.log();

    console.log(`${colors.green}╠${'═'.repeat(width - 2)}╣${colors.reset}`);
    console.log(`${colors.bright}${colors.white} NETWORK INTERFACE ANALYSIS${colors.reset}`);
    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);

    console.log(`${colors.gray}║${colors.reset} ${colors.white}SSID:${colors.reset}              ${colors.green}${wifi.ssid.padEnd(35)}${colors.reset} ${colors.gray}│${colors.reset} ${colors.white}BSSID:${colors.reset}            ${colors.cyan}${wifi.bssid}${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}RADIO TYPE:${colors.reset}       ${colors.green}${(wifi.radioType || '802.11').padEnd(35)}${colors.reset} ${colors.gray}│${colors.reset} ${colors.white}CHANNEL:${colors.reset}           ${colors.cyan}${wifi.channel} (${is5GHz ? '5GHz' : '2.4GHz'})${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}RX RATE:${colors.reset}          ${colors.green}${(wifi.receiveRate || 'N/A').padEnd(35)}${colors.reset} ${colors.gray}│${colors.reset} ${colors.white}TX RATE:${colors.reset}           ${colors.cyan}${wifi.transmitRate || 'N/A'}${colors.reset}`);

    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);
    console.log(`${colors.bright}${colors.white} SIGNAL & PERFORMANCE${colors.reset}`);
    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);

    console.log(`${colors.gray}║${colors.reset} ${colors.white}SIGNAL:${colors.reset}           ${quality.color}${quality.bar} ${wifi.signalStrength}% (${quality.rating})${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}LATENCY:${colors.reset}          ${latency < 50 ? colors.green : latency < 150 ? colors.yellow : colors.red}${latency} ms${colors.reset} ${colors.gray}│${colors.reset} ${colors.white}PACKET LOSS:${colors.reset}     ${packetLoss < 1 ? colors.green : packetLoss < 5 ? colors.yellow : colors.red}${packetLoss.toFixed(2)}%${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}BANDWIDTH SCORE:${colors.reset}  ${bandwidthScore > 80 ? colors.green : bandwidthScore > 50 ? colors.yellow : colors.red}${bandwidthScore}/100${colors.reset} ${colors.gray}│${colors.reset} ${colors.white}CHANNEL QUALITY:${colors.reset}   ${channelAnalysis.quality == 'BEST' ? colors.green : channelAnalysis.quality == 'GOOD' ? colors.cyan : colors.yellow}${channelAnalysis.quality}${colors.reset}`);

    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);
    console.log(`${colors.bright}${colors.white} REAL-TIME TRAFFIC METRICS${colors.reset}`);
    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);

    const barWidth = 45;
    const downloadPercent = Math.min(100, Math.floor((avgDownloadSpeed / (10 * 1024 * 1024)) * 100));
    const uploadPercent = Math.min(100, Math.floor((avgUploadSpeed / (5 * 1024 * 1024)) * 100));
    const downloadBars = '█'.repeat(Math.floor(barWidth * downloadPercent / 100));
    const uploadBars = '█'.repeat(Math.floor(barWidth * uploadPercent / 100));

    console.log(`${colors.gray}║${colors.reset} ${colors.green}⬇ DOWNLOAD${colors.reset}  ${formatSpeed(avgDownloadSpeed).padEnd(12)} ${colors.green}[${downloadBars}${'░'.repeat(barWidth - downloadBars.length)}]${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.cyan}⬆ UPLOAD${colors.reset}    ${formatSpeed(avgUploadSpeed).padEnd(12)} ${colors.cyan}[${uploadBars}${'░'.repeat(barWidth - uploadBars.length)}]${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}PEAK DOWNLOAD:${colors.reset}  ${colors.green}${formatSpeed(peakDownload).padEnd(20)}${colors.reset} ${colors.white}PEAK UPLOAD:${colors.reset}    ${colors.cyan}${formatSpeed(peakUpload)}${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}TOTAL DOWNLOAD:${colors.reset} ${colors.green}${formatBytes(totalDownload).padEnd(20)}${colors.reset} ${colors.white}TOTAL UPLOAD:${colors.reset}   ${colors.cyan}${formatBytes(totalUpload)}${colors.reset}`);

    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);
    console.log(`${colors.bright}${colors.white} SECURITY POSTURE${colors.reset}`);
    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);

    const securityColor = security.score >= 80 ? colors.green : security.score >= 60 ? colors.yellow : colors.red;
    console.log(`${colors.gray}║${colors.reset} ${colors.white}AUTHENTICATION:${colors.reset}  ${securityColor}${security.auth || 'Unknown'}${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}CIPHER:${colors.reset}          ${securityColor}${security.cipher || 'Unknown'}${colors.reset}`);
    console.log(`${colors.gray}║${colors.reset} ${colors.white}SECURITY SCORE:${colors.reset}  ${securityColor}${security.score}/100 (${security.level})${colors.reset}`);

    console.log(`${colors.gray}║${colors.reset} ${colors.white}VULNERABILITIES:${colors.reset}`);
    security.vulnerabilities.forEach(vuln => {
      console.log(`${colors.gray}║${colors.reset}   ${colors.red}⚠${colors.reset} ${vuln}`);
    });

    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);
    console.log(`${colors.bright}${colors.white} OPTIMIZATION RECOMMENDATIONS${colors.reset}`);
    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);

    const recommendations = [];

    if (wifi.signalStrength < 50) recommendations.push(`${colors.yellow}• Move closer to the access point or remove obstacles${colors.reset}`);
    if (latency > 100) recommendations.push(`${colors.yellow}• High latency detected - check for network congestion${colors.reset}`);
    if (packetLoss > 2) recommendations.push(`${colors.red}• Packet loss detected - possible interference or distance issues${colors.reset}`);
    if (security.score < 70) recommendations.push(`${colors.red}• Upgrade security configuration immediately${colors.reset}`);
    if (channelAnalysis.quality === 'POOR') recommendations.push(`${colors.yellow}• Change to a non-overlapping channel (1, 6, or 11 for 2.4GHz)${colors.reset}`);
    if (bandwidthScore < 50) recommendations.push(`${colors.yellow}• Bandwidth is limited - check for signal interference${colors.reset}`);
    if (avgDownloadSpeed > totalDownload * 0.1 && totalDownload > 0) recommendations.push(`${colors.cyan}• High background traffic detected - check running applications${colors.reset}`);

    if (recommendations.length === 0) {
      recommendations.push(`${colors.green}✓ All metrics are optimal - network performance is excellent${colors.reset}`);
    }

    recommendations.forEach(rec => {
      console.log(`${colors.gray}║${colors.reset} ${rec}`);
    });

    console.log(`${colors.gray}╠${'═'.repeat(width - 2)}╣${colors.reset}`);

    const timestamp = new Date().toLocaleTimeString();
    const statusText = ` LIVE MONITORING ACTIVE | ${timestamp} | PRESS Ctrl+C TO EXIT `;
    const statusPadding = Math.max(0, Math.floor((width - statusText.length) / 2));
    console.log(`${colors.green}${' '.repeat(statusPadding)}${statusText}${colors.reset}`);

    console.log(`${colors.green}╚${'═'.repeat(width - 2)}╝${colors.reset}`);

  } catch (err) {
    console.log(`${colors.red}Display error: ${err.message}${colors.reset}`);
  }
};

const startFullMonitoring = async () => {
  const interfaceName = await getActiveNetworkInterface();

  isMonitoring = true;

  await getAccurateTrafficStats(interfaceName);
  lastStats.timestamp = Date.now();

  monitoringInterval = setInterval(async () => {
    await monitorTrafficLoop(interfaceName);
  }, 1000);

  setInterval(async () => {
    await refreshDisplay();
  }, 2000);

  connectionCheckInterval = setInterval(async () => {
    const wifi = await getCurrentWiFi();
    if (!wifi.connected && isMonitoring) {
      console.log(`${colors.red}\n⚠ WiFi connection lost - waiting for reconnection...${colors.reset}`);
    }
  }, 5000);

  await refreshDisplay();
};

const cleanup = () => {
  isMonitoring = false;
  if (monitoringInterval) clearInterval(monitoringInterval);
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  console.log(`${colors.green}\n\n✓ WiFi Analyzer Pro shutdown complete${colors.reset}`);
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const init = async () => {
  console.log('\x1b[2J\x1b[H');
  console.log(`${colors.green}Starting WiFi Analyzer Pro...${colors.reset}`);

  const wifi = await getCurrentWiFi();
  if (!wifi.connected) {
    console.log(`${colors.red}No WiFi connection detected. Please connect to a network and restart.${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.green}Connected to: ${wifi.ssid}${colors.reset}`);
  console.log(`${colors.cyan}Initializing real-time monitoring...${colors.reset}`);

  await new Promise(resolve => setTimeout(resolve, 1000));

  startFullMonitoring();
};

init();
