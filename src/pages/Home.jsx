// src/pages/Home.jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';

export default function Home() {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState('');

  const createCall = () => {
    const newSession = uuidv4();
    navigate(`/call/${newSession}`);
  };

  const joinCall = () => {
    if (sessionId) navigate(`/call/${sessionId}`);
  };

  return (
    <div className="p-4 text-center">
      <h1 className="text-xl mb-4">Simple WebRTC with Supabase</h1>
      <button onClick={createCall} className="border p-2 m-2">Create Call</button>
      <div>
        <input
          type="text"
          placeholder="Enter Session ID"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="border p-2 m-2"
        />
        <button onClick={joinCall} className="border p-2 m-2">Join Call</button>
      </div>
    </div>
  );
}