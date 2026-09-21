const { execSync } = require('child_process');
try {
  console.log('Deploying to Vercel...');
  execSync('npx vercel --prod --yes', { stdio: 'inherit' });
  console.log('Deployment successful!');
} catch (e) {
  console.error('Deployment failed:', e.message);
}
