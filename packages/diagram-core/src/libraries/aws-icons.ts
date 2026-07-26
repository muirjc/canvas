import type { IconShapeLibraryManifest } from './library-loader.js';
import { placeholderIconMarkup } from './placeholder-icon.js';

/**
 * ⚠️ PLACEHOLDER ARTWORK, NOT AWS'S OFFICIAL ICONS.
 *
 * AWS's actual "AWS Architecture Icons" are proprietary assets published under AWS's own
 * license/usage terms (see the constitution's Technology & Compliance Constraints). This
 * reference implementation cannot fetch or redistribute that proprietary asset pack, so it
 * ships structurally-correct *placeholder* icons instead — same manifest shape and ingestion
 * path (`loadLibrary`, Constitution V) a real deployment would use. Before shipping to real
 * users, an admin must replace `icons[].assetRef` with the actual licensed SVG artwork
 * downloaded from AWS's official Architecture Icons package.
 */
export const awsIconsManifest: IconShapeLibraryManifest = {
  id: 'aws-icons',
  version: '2024.1-placeholder',
  license:
    'PLACEHOLDER ARTWORK — replace with AWS Architecture Icons under AWS\'s published usage terms before production use.',
  icons: [
    { id: 'ec2', displayName: 'Amazon EC2', keywords: ['compute', 'vm', 'server', 'instance'], category: 'Compute', assetRef: placeholderIconMarkup('EC2', '#ec7211') },
    { id: 'lambda', displayName: 'AWS Lambda', keywords: ['compute', 'serverless', 'function'], category: 'Compute', assetRef: placeholderIconMarkup('λ', '#ec7211') },
    { id: 's3', displayName: 'Amazon S3', keywords: ['storage', 'bucket', 'object'], category: 'Storage', assetRef: placeholderIconMarkup('S3', '#7aa116') },
    { id: 'dynamodb', displayName: 'Amazon DynamoDB', keywords: ['database', 'nosql', 'data'], category: 'Database', assetRef: placeholderIconMarkup('DDB', '#4053d6') },
    { id: 'rds', displayName: 'Amazon RDS', keywords: ['database', 'sql', 'relational'], category: 'Database', assetRef: placeholderIconMarkup('RDS', '#4053d6') },
    { id: 'vpc', displayName: 'Amazon VPC', keywords: ['network', 'vpc'], category: 'Networking', assetRef: placeholderIconMarkup('VPC', '#8c4fff') },
    { id: 'iam', displayName: 'AWS IAM', keywords: ['security', 'identity', 'access'], category: 'Security', assetRef: placeholderIconMarkup('IAM', '#dd344c') },
    { id: 'elb', displayName: 'Elastic Load Balancing', keywords: ['network', 'balancer'], category: 'Networking', assetRef: placeholderIconMarkup('ELB', '#8c4fff') },
  ],
};
