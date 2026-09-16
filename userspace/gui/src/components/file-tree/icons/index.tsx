import React from 'react';
import UiIcon, { type UiIconProps } from '../../../icons/registry';
type IconProps = Omit<UiIconProps, 'name'>;

export const ChevronRightIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="chevronRight" />;
export const ChevronDownIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="chevronDown" />;
export const FolderIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="folder" />;
export const FolderOpenIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="folderOpen" />;
export const FileIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="file" />;
export const RefreshIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="refresh" />;
export const NewFileIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="newFile" />;
export const NewFolderIcon: React.FC<IconProps> = (props) => <UiIcon size={16} {...props} name="newFolder" />;
