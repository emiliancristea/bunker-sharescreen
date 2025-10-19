const socket = io();

let currentRoom = null;
let localStream = null;
let isSharing = false;
let shareReservation = false;
let targetFrameRate = 60;
let targetBitrate = 12_000_000;

const peers = new Map(); // userId -> { pc: RTCPeerConnection, isInitiator: boolean }
const connectedUsers = new Set();
const remoteSharers = new Set();

// DOM elements
const roomIdInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');
const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const frameRateSelect = document.getElementById('frameRate');
const localVideo = document.getElementById('localVideo');
const roomStatus = document.getElementById('roomStatus');
const remoteVideos = document.getElementById('remoteVideos');
const shareSection = document.querySelector('.share-section');

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
  ]
};

function removeRemoteScreen(userId) {
  const wrapper = document.getElementById(`screen-wrapper-${userId}`);
  if (!wrapper) {
    return;
  }

  const video = wrapper.querySelector('video');
  if (video && video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }

  wrapper.remove();
}

function updateNotSharingStatus() {
  if (isSharing) {
    return;
  }

  if (remoteSharers.size > 0) {
    roomStatus.textContent = 'Watching remote share…';
  } else if (currentRoom) {
    roomStatus.textContent = `Connected to room: ${currentRoom} (not sharing)`;
  } else {
    roomStatus.textContent = '';
  }
}

function toggleFullscreen(element) {
  if (!document.fullscreenElement) {
    element.requestFullscreen().catch(err => {
      console.error('Error entering fullscreen:', err);
    });
  } else {
    document.exitFullscreen().catch(err => {
      console.error('Error exiting fullscreen:', err);
    });
  }
}

function computeBitrate(frameRate) {
  if (frameRate >= 120) {
    return 20_000_000;
  }
  if (frameRate >= 90) {
    return 16_000_000;
  }
  return 12_000_000;
}

function cleanupOutgoingPeers() {
  peers.forEach((info, userId) => {
    if (info.isInitiator) {
      info.pc.ontrack = null;
      info.pc.onicecandidate = null;
      info.pc.close();
      peers.delete(userId);
    }
  });
}

function removePeer(userId) {
  const info = peers.get(userId);
  if (info) {
    info.pc.ontrack = null;
    info.pc.onicecandidate = null;
    info.pc.close();
    peers.delete(userId);
  }

  removeRemoteScreen(userId);
}

function handleRemoteTrack(userId, stream) {
  if (!stream) {
    return;
  }

  let wrapper = document.getElementById(`screen-wrapper-${userId}`);
  let video;

  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'remote-screen';
    wrapper.id = `screen-wrapper-${userId}`;

    const label = document.createElement('p');
    label.textContent = `User: ${userId.substring(0, 8)}… (Click to fullscreen)`;

    video = document.createElement('video');
    video.id = `screen-${userId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // allow autoplay without gesture
    video.controls = false;
    video.style.cursor = 'pointer';

    video.addEventListener('click', () => {
      toggleFullscreen(video);
    });

    wrapper.appendChild(label);
    wrapper.appendChild(video);
    remoteVideos.appendChild(wrapper);
  } else {
    video = wrapper.querySelector('video');
  }

  if (video) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
}

function createPeerConnection(userId, isInitiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (event) => {
    if (event.candidate && currentRoom) {
      socket.emit('ice-candidate', {
        roomId: currentRoom,
        targetId: userId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    handleRemoteTrack(userId, stream);
  };

  pc.oniceconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
      if (!isInitiator) {
        removePeer(userId);
      }
    }
  };

  peers.set(userId, { pc, isInitiator });
  return pc;
}

async function startPeerConnection(targetId) {
  if (!localStream || !currentRoom || !isSharing) {
    return;
  }

  if (targetId === socket.id) {
    return;
  }

  const existing = peers.get(targetId);
  if (existing?.isInitiator) {
    return;
  }
  if (existing) {
    removePeer(targetId);
  }

  const pc = createPeerConnection(targetId, true);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.getSenders().forEach(sender => {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings) {
        params.encodings = [{}];
      }
      params.encodings[0].maxFramerate = targetFrameRate;
      params.encodings[0].maxBitrate = targetBitrate;
      sender.setParameters(params).catch(err => {
        console.warn('Failed to set RTP parameters:', err);
      });
    }
  });

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: true
    });
    await pc.setLocalDescription(offer);

    socket.emit('offer', {
      roomId: currentRoom,
      targetId,
      description: pc.localDescription
    });
  } catch (err) {
    console.error('Failed to create/send offer:', err);
    removePeer(targetId);
  }
}

function onRemoteSharerStarted(userId) {
  if (!userId || remoteSharers.has(userId)) {
    return;
  }

  remoteSharers.add(userId);

  if (!isSharing) {
    shareBtn.disabled = true;
    roomStatus.textContent = 'Remote share in progress…';
  }
}

function onRemoteSharerStopped(userId) {
  if (!userId) {
    return;
  }

  remoteSharers.delete(userId);
  removePeer(userId);

  if (!isSharing && remoteSharers.size === 0) {
    shareBtn.disabled = false;
    updateNotSharingStatus();
  }
}

function cancelShareSlot() {
  if (shareReservation && currentRoom) {
    socket.emit('cancel-share', currentRoom);
    shareReservation = false;
  }
}

function stopSharing() {
  if (!isSharing && !shareReservation) {
    return;
  }

  cleanupOutgoingPeers();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  if (currentRoom && shareReservation) {
    socket.emit('stop-sharing', currentRoom);
  }

  shareReservation = false;
  isSharing = false;

  localVideo.srcObject = null;
  shareBtn.style.display = 'inline-block';
  stopBtn.style.display = 'none';

  if (remoteSharers.size === 0) {
    shareBtn.disabled = false;
  }

  updateNotSharingStatus();
}

// Join room
joinBtn.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    alert('Please enter a room ID');
    return;
  }

  currentRoom = roomId;
  socket.emit('join-room', roomId);
  shareSection.style.display = 'block';
  roomIdInput.disabled = true;
  joinBtn.disabled = true;
  shareBtn.disabled = false;
  updateNotSharingStatus();
});

// Share screen
shareBtn.addEventListener('click', async () => {
  if (!currentRoom) {
    alert('Join a room before sharing.');
    return;
  }

  if (remoteSharers.size > 0) {
    alert('Another user is currently sharing. Please wait for them to finish.');
    return;
  }

  shareBtn.disabled = true;

  const response = await new Promise(resolve => {
    socket.emit('request-share', { roomId: currentRoom }, (res) => {
      resolve(res || { ok: false, reason: 'No response from server.' });
    });
  });

  if (!response.ok) {
    shareBtn.disabled = false;
    if (response.reason) {
      alert(response.reason);
    }
    return;
  }

  shareReservation = true;

  targetFrameRate = parseInt(frameRateSelect.value, 10) || 60;
  targetBitrate = computeBitrate(targetFrameRate);

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: targetFrameRate, max: targetFrameRate },
        displaySurface: 'monitor',
        cursor: 'always'
      },
      audio: false
    });
  } catch (err) {
    console.error('Error accessing screen:', err);
    cancelShareSlot();
    shareBtn.disabled = remoteSharers.size > 0;
    return;
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
    videoTrack.applyConstraints({
      frameRate: targetFrameRate
    }).catch(err => {
      console.warn('Unable to apply frame rate constraint:', err);
    });
  }

  localVideo.srcObject = localStream;
  localVideo.play().catch(() => {});
  isSharing = true;
  roomStatus.textContent = `Sharing at ${targetFrameRate} FPS`;
  shareBtn.style.display = 'none';
  stopBtn.style.display = 'inline-block';
  shareBtn.disabled = false;

  localStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    stopSharing();
  });

  connectedUsers.forEach((userId) => {
    startPeerConnection(userId);
  });
});

// Stop sharing
stopBtn.addEventListener('click', () => {
  stopSharing();
});

// Add fullscreen to local video
localVideo.addEventListener('click', () => {
  toggleFullscreen(localVideo);
});
localVideo.style.cursor = 'pointer';

// Socket.io handlers
socket.on('existing-users', (users) => {
  connectedUsers.clear();
  if (Array.isArray(users)) {
    users.forEach(userId => connectedUsers.add(userId));
  }
});

socket.on('user-joined', (userId) => {
  if (!userId) {
    return;
  }
  connectedUsers.add(userId);
  if (isSharing) {
    startPeerConnection(userId);
  }
});

socket.on('user-left', (userId) => {
  if (!userId) {
    return;
  }
  connectedUsers.delete(userId);
  onRemoteSharerStopped(userId);
});

socket.on('user-stopped-sharing', (userId) => {
  onRemoteSharerStopped(userId);
});

socket.on('user-started-sharing', (userId) => {
  onRemoteSharerStarted(userId);
});

socket.on('current-sharer', (userId) => {
  if (userId) {
    onRemoteSharerStarted(userId);
  }
});

socket.on('offer', async ({ userId, description }) => {
  if (!currentRoom || !userId || !description) {
    return;
  }

  const existing = peers.get(userId);
  if (existing) {
    removePeer(userId);
  }

  const pc = createPeerConnection(userId, false);

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer', {
      roomId: currentRoom,
      targetId: userId,
      description: pc.localDescription
    });
  } catch (err) {
    console.error('Failed to process offer:', err);
    removePeer(userId);
  }
});

socket.on('answer', async ({ userId, description }) => {
  if (!userId || !description) {
    return;
  }

  const info = peers.get(userId);
  if (!info || !info.isInitiator) {
    return;
  }

  try {
    await info.pc.setRemoteDescription(new RTCSessionDescription(description));
  } catch (err) {
    console.error('Failed to apply answer:', err);
  }
});

socket.on('ice-candidate', async ({ userId, candidate }) => {
  if (!userId || !candidate) {
    return;
  }

  const info = peers.get(userId);
  if (!info) {
    return;
  }

  try {
    await info.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
});

socket.on('room-joined', (roomId) => {
  currentRoom = roomId;
  updateNotSharingStatus();
});

socket.on('room-error', (message) => {
  alert(message || 'Failed to join room.');
  shareSection.style.display = 'none';
  roomStatus.textContent = '';
  roomIdInput.disabled = false;
  joinBtn.disabled = false;
  shareBtn.disabled = false;
  currentRoom = null;
});
